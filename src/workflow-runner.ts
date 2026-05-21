// Shared workflow-invocation glue used by both surfaces that can start a
// run: the command-palette flow (src/commands/register.ts) and the
// workflows pane (src/views/workflows-view.ts).
//
// Everything here corresponds to the spec's invocation flow (§8.1):
//   1. capture RunContext per the prompt's declared `context` tokens;
//   2. POST /v1/run;
//   3. open the chat-view leaf and attach the SSE stream.

import { App, MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type {
  ContextToken,
  Input,
  ManifestEntry,
  RunContext,
  RunRequest,
  VaultMode,
} from "./protocol";

import type { EventStream, FeynmanClient } from "./transport/client";
import {
  FeynmanChatView,
  VIEW_TYPE_FEYNMAN_CHAT,
} from "./views/chat-view";

/**
 * Subset of the plugin surface the runner uses for the active-run registry.
 * Decoupled so this file doesn't import `main.ts` (circular) and the runner
 * can be smoke-tested without a real Plugin instance.
 */
export interface ActiveRunRegistry {
  registerActiveRun: (
    runId: string,
    stream: EventStream,
    cleanup: () => void,
  ) => void;
  unregisterActiveRun: (runId: string) => void;
}

export interface RunWorkflowDeps {
  client: FeynmanClient;
  getVaultMode: () => VaultMode;
  getModel: () => string | undefined;
  /**
   * Optional accessor for the user's "auto-open created documents"
   * preference. Threaded into the chat view so it can decide whether to
   * open artifacts in new panes after `run.done`.
   */
  getAutoOpenArtifacts?: () => "off" | "last" | "all";
  /** Optional vault-relative workspace folder; passed through to the chat
   * view so artifact-path validation matches the user's configured root. */
  getWorkspaceFolder?: () => string;
  /** Whether to auto-yes `tool.approval_required` and `agent.question`. */
  getAutoApproveAgentPrompts?: () => boolean;
  /**
   * Optional hook invoked whenever a non-empty SSE framing `id:` is observed
   * on an event from the run. Wired by Agent 6 in Wave 3 to persist
   * `(runId, lastEventId)` to plugin data so a vault reload can resume the
   * stream with `Last-Event-ID`. The plumbing lives here; persistence is
   * deferred to the caller.
   */
  onLastEventIdAdvance?: (runId: string, eventId: string) => void;
  /**
   * Optional active-run registry. When present, the runner registers the
   * stream on run start and unregisters on terminal events. Wave 3 Agent 6
   * wires this from the plugin so `onunload` can cancel + close everything.
   */
  registry?: ActiveRunRegistry;
  /**
   * Fired when the run terminates (run.done / run.error / chat view closed).
   * The workflows sidebar uses this to keep its "Running /<slug>…" label live
   * until the stream is actually done — without this hook the button reverts
   * the moment `runWorkflow` resolves (which is right after the chat view
   * opens, NOT when the run finishes).
   */
  onRunFinished?: (status: "done" | "error" | "aborted") => void;
}

/**
 * State an in-flight run carries between sessions. Persisted by Agent 6 in
 * Wave 3; consumed by `resumeWorkflow` below. `lastEventId` is the SSE
 * framing id of the last delivered event (string per SSE spec).
 */
export interface PersistedRunState {
  runId: string;
  lastEventId?: string;
}

/**
 * Execute a workflow end-to-end: capture context, POST /v1/run, open chat,
 * attach the SSE stream. Shows an Obsidian Notice on failure.
 */
export async function runWorkflow(
  app: App,
  entry: ManifestEntry,
  args: Record<string, unknown>,
  deps: RunWorkflowDeps,
): Promise<void> {
  const context = await captureRunContext(app, entry.context);
  const req: RunRequest = {
    prompt: entry.slug,
    args,
    vaultMode: deps.getVaultMode(),
    context: hasAnyContext(context) ? context : undefined,
  };
  const model = deps.getModel();
  if (model !== undefined && model.length > 0) {
    req.model = model;
  }
  try {
    const res = await deps.client.postRun(req);
    const view = await openChatLeaf(app);
    if (view !== null) {
      view.setInputPoster((input: Input) =>
        deps.client.postInput(res.runId, input),
      );
      if (deps.registry !== undefined) {
        view.setPluginRef(deps.registry);
      }
      view.setRunContext(res.runId, new Set());
      if (deps.getWorkspaceFolder !== undefined) {
        view.setWorkspaceFolder(deps.getWorkspaceFolder());
      }
      if (deps.getAutoOpenArtifacts !== undefined) {
        view.setAutoOpenArtifacts(deps.getAutoOpenArtifacts());
      }
      if (deps.getAutoApproveAgentPrompts !== undefined) {
        view.setAutoApproveAgentPrompts(deps.getAutoApproveAgentPrompts());
      }
      if (deps.onRunFinished !== undefined) {
        view.setOnRunFinished(deps.onRunFinished);
      }
      const onLastEventIdAdvance = deps.onLastEventIdAdvance;
      const stream = deps.client.openEvents(res.runId, {
        onFramingId:
          onLastEventIdAdvance !== undefined
            ? (eventId) => onLastEventIdAdvance(res.runId, eventId)
            : undefined,
      });
      if (deps.registry !== undefined) {
        deps.registry.registerActiveRun(res.runId, stream, () => stream.close());
      }
      void view.attachStream(stream);
    } else if (deps.onRunFinished !== undefined) {
      // Chat view couldn't open — fire the callback so the sidebar button
      // doesn't get stuck in "Running" state.
      deps.onRunFinished("error");
    }
  } catch (err) {
    new Notice(
      `Feynman: run failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    deps.onRunFinished?.("error");
  }
}

/**
 * Reattach to a previously-started run after a vault reload. Verifies the
 * run still exists on the server (so a stale persisted runId surfaces as a
 * clean error rather than a hung reconnect loop) before opening the SSE
 * stream with `Last-Event-ID`. Wave 1 ships the plumbing; Agent 6 (Wave 3)
 * wires this into the lifecycle layer.
 */
export async function resumeWorkflow(
  app: App,
  state: PersistedRunState,
  deps: RunWorkflowDeps,
): Promise<void> {
  try {
    // Verify the run exists before subscribing. If the server has GC'd it,
    // getRun throws a clear HTTP 404 instead of us looping on the SSE GET
    // until the auth-failed / unknown-run mapping fires.
    await deps.client.getRun(state.runId);
    const view = await openChatLeaf(app);
    if (view !== null) {
      view.setInputPoster((input: Input) =>
        deps.client.postInput(state.runId, input),
      );
      if (deps.registry !== undefined) {
        view.setPluginRef(deps.registry);
      }
      view.setRunContext(state.runId, new Set());
      if (deps.getWorkspaceFolder !== undefined) {
        view.setWorkspaceFolder(deps.getWorkspaceFolder());
      }
      if (deps.getAutoOpenArtifacts !== undefined) {
        view.setAutoOpenArtifacts(deps.getAutoOpenArtifacts());
      }
      if (deps.getAutoApproveAgentPrompts !== undefined) {
        view.setAutoApproveAgentPrompts(deps.getAutoApproveAgentPrompts());
      }
      const onLastEventIdAdvance = deps.onLastEventIdAdvance;
      const stream = deps.client.openEvents(state.runId, {
        lastEventId: state.lastEventId,
        onFramingId:
          onLastEventIdAdvance !== undefined
            ? (eventId) => onLastEventIdAdvance(state.runId, eventId)
            : undefined,
      });
      if (deps.registry !== undefined) {
        deps.registry.registerActiveRun(state.runId, stream, () => stream.close());
      }
      void view.attachStream(stream);
    }
  } catch (err) {
    new Notice(
      `Feynman: resume failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------
// RunContext capture (§8.1)
// ---------------------------------------------------------------------

export async function captureRunContext(
  app: App,
  tokens: ContextToken[],
): Promise<RunContext> {
  const ctx: RunContext = {};
  if (tokens.includes("activeFile")) {
    const af = await captureActiveFile(app);
    if (af !== null) ctx.activeFile = af;
  }
  if (tokens.includes("selection")) {
    const sel = captureSelection(app);
    if (sel !== null) ctx.selection = sel;
  }
  if (tokens.includes("openTabs")) {
    ctx.openTabs = captureOpenTabs(app);
  }
  return ctx;
}

function hasAnyContext(ctx: RunContext): boolean {
  return (
    ctx.activeFile !== undefined ||
    ctx.selection !== undefined ||
    (ctx.openTabs !== undefined && ctx.openTabs.length > 0)
  );
}

async function captureActiveFile(
  app: App,
): Promise<RunContext["activeFile"] | null> {
  const file = app.workspace.getActiveFile();
  if (file === null) return null;
  if (!(file instanceof TFile)) return null;
  const content = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter =
    cache?.frontmatter !== undefined
      ? (cache.frontmatter as Record<string, unknown>)
      : undefined;
  const out: RunContext["activeFile"] = {
    path: file.path,
    content,
  };
  if (frontmatter !== undefined) {
    out.frontmatter = frontmatter;
  }
  return out;
}

function captureSelection(app: App): RunContext["selection"] | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view === null) return null;
  const file: TFile | null = view.file;
  if (file === null) return null;
  const editor: Editor = view.editor;
  const text = editor.getSelection();
  if (text.length === 0) return null;
  const fromPos = editor.getCursor("from");
  const toPos = editor.getCursor("to");
  const from = editor.posToOffset(fromPos);
  const to = editor.posToOffset(toPos);
  return {
    path: file.path,
    text,
    range: { from, to },
  };
}

function captureOpenTabs(app: App): RunContext["openTabs"] {
  const leaves = app.workspace.getLeavesOfType("markdown");
  const out: { path: string }[] = [];
  for (const leaf of leaves) {
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const file = view.file;
      if (file !== null) out.push({ path: file.path });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Chat-view leaf management
// ---------------------------------------------------------------------

/**
 * Reveal the chat view, opening it if absent. When opening for the first
 * time, splits the right sidebar so it sits beside (not over) any other
 * Feynman pane the user already has open (e.g. the workflows view).
 */
export async function openChatLeaf(
  app: App,
): Promise<FeynmanChatView | null> {
  const workspace = app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_FEYNMAN_CHAT);
  let leaf = existing[0] ?? null;
  if (leaf === null) {
    leaf = workspace.getRightLeaf(true) ?? workspace.getLeaf(true);
    if (leaf !== null) {
      await leaf.setViewState({
        type: VIEW_TYPE_FEYNMAN_CHAT,
        active: true,
      });
    }
  }
  if (leaf === null) return null;
  workspace.revealLeaf(leaf);
  const view = leaf.view;
  return view instanceof FeynmanChatView ? view : null;
}
