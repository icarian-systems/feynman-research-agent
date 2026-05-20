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
} from "@feynman/protocol";

import type { FeynmanClient } from "./transport/client";
import {
  FeynmanChatView,
  VIEW_TYPE_FEYNMAN_CHAT,
} from "./views/chat-view";

export interface RunWorkflowDeps {
  client: FeynmanClient;
  getVaultMode: () => VaultMode;
  getModel: () => string | undefined;
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
      const stream = deps.client.openEvents(res.runId, {});
      void view.attachStream(stream);
    }
  } catch (err) {
    new Notice(
      `Feynman: run failed — ${err instanceof Error ? err.message : String(err)}`,
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
