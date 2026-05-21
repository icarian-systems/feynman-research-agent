// Primary research surface. See docs/ARCHITECTURE.md §8.2.
//
// Hybrid render contract (§8.2):
//   - while an `agent.message` streams, render the block as plain <pre>,
//     updated per delta;
//   - on the closing event (or 250 ms of stream idle), re-render once
//     through MarkdownRenderer for code-fence highlighting, links, embeds;
//   - `agent.thinking` streams into a collapsed dim block attached to the
//     message it precedes; never re-rendered as full markdown;
//   - `tool.call` is a collapsible block; `tool.approval_required` opens
//     a modal; `artifact.written` posts a clickable internal link.

import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
} from "obsidian";
import type { Event, Input } from "../protocol";
import type { EventStream } from "../transport/client";

import { FsBridgeHandler } from "../fs-bridge/handler";
import { ToolApprovalModal, type ApprovalDecision } from "./tool-approval";

export const VIEW_TYPE_FEYNMAN_CHAT = "feynman-chat";

/**
 * Schedule `fn` at the next idle boundary. Uses `requestIdleCallback` when
 * available (Electron 25+) and falls back to a `setTimeout(0)` shim. Returns
 * a cancel handle the caller can use to drop a pending render if the message
 * mutates again before the idle fires.
 */
type IdleHandle = { cancel: () => void };
export function scheduleIdleRender(fn: () => void): IdleHandle {
  const g = globalThis as {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof g.requestIdleCallback === "function") {
    const id = g.requestIdleCallback(fn, { timeout: 250 });
    return {
      cancel: () => {
        try {
          g.cancelIdleCallback?.(id);
        } catch {
          // ignore — no-op when the platform doesn't expose cancel
        }
      },
    };
  }
  const t = window.setTimeout(fn, 0);
  return { cancel: () => window.clearTimeout(t) };
}

/**
 * Sentinel `sourcePath` passed to `MarkdownRenderer.render` for every
 * agent-supplied markdown surface. The file deliberately doesn't exist —
 * using a path that isn't anchored at the vault root prevents Obsidian's
 * wiki-link resolver from dereferencing an agent-emitted `[[../etc/passwd]]`
 * against real vault files. Pair with `sanitizeAgentMarkdown` below.
 */
const VIRTUAL_SOURCE_PATH = ".feynman/__virtual__.md";

/**
 * Strip dangerous syntax from agent-supplied markdown before it hits
 * `MarkdownRenderer.render`. Two passes:
 *   1. Drop Obsidian embed syntax `![[...]]` — embeds dereference vault
 *      paths and would render arbitrary attachments / linked images at the
 *      agent's request.
 *   2. Rewrite dangerous-scheme inline links so the visible text is
 *      preserved but the href becomes `#`. `javascript:` and `data:` are
 *      obvious XSS vectors; `file:` would let an agent surface local-file
 *      links to the user as if they were normal documents.
 */
export function sanitizeAgentMarkdown(md: string): string {
  return (
    md
      // 1. Strip Obsidian embed syntax — embeds bypass click-through and
      // render inline at the agent's request.
      .replace(/!\[\[[^\]]*\]\]/g, "")
      // 2. Neutralize dangerous schemes; preserve link text, repoint href.
      .replace(
        /\[([^\]]*)\]\((javascript|data|file):[^)]*\)/gi,
        "[$1](#)",
      )
  );
}

/**
 * Validate an agent-supplied artifact path against a vault-relative
 * Returns the path verbatim (vault-relative, no transformation) on accept,
 * or null on reject. The `workspaceFolder` arg is no longer used for
 * coercion — see the note below.
 *
 * Why the workspace-folder rewrite was removed:
 *   In v0 this helper forcibly prepended `workspaceFolder` (`Feynman/`) when
 *   the agent's path didn't already start with it. But Pi's `write` tool
 *   resolves relative paths against cwd (= `/vault` inside the container =
 *   vault root). When the agent wrote `output/foo.md` the real file landed
 *   at `<vault>/output/foo.md` while the plugin reported and auto-opened
 *   `Feynman/output/foo.md` — Obsidian's `openLinkText` then *created* a
 *   blank stub at that bogus path. Honour the agent's path; the vault
 *   itself is the sandbox.
 *
 * Security guards (kept):
 *   - Empty path rejected.
 *   - Absolute path (`/...`) rejected.
 *   - Any `..` segment rejected (no path traversal).
 *   - Scheme prefixes rejected (http:, https:, file:, javascript:, data:).
 */
export function validateArtifactPath(
  rawPath: string,
  _workspaceFolder: string,
): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  // Disallow scheme-prefixed paths — these would render as external links.
  if (/^(?:https?|file|javascript|data):/i.test(rawPath)) return null;
  // Absolute paths escape the vault — reject.
  if (rawPath.startsWith("/")) return null;
  // Any `..` segment is a traversal attempt; reject without trying to
  // canonicalize.
  if (rawPath.includes("..")) return null;
  // Strip a leading "./" for cosmetic consistency in the callout.
  const cleaned = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Caller-supplied hook the chat view uses for outbound input (approvals,
 * answers). Decoupled from FeynmanClient so the chat view can also be opened
 * standalone (e.g. for replay) without a live client.
 */
export type InputPoster = (input: Input) => Promise<void>;

/** Per-message bookkeeping. */
type MessageBlock = {
  el: HTMLElement;
  bodyEl: HTMLElement;
  thinkingEl: HTMLElement | null;
  markdown: string;
  thinkingMarkdown: string;
  // Pending idle render handle. Null when no render is scheduled.
  idle: IdleHandle | null;
  rendered: boolean;
  closed: boolean;
};

type AgentQuestionEvent = Extract<Event, { type: "agent.question" }>;

export class FeynmanChatView extends ItemView {
  private logEl: HTMLElement | null = null;
  private inputPoster: InputPoster | null = null;
  private sourcePath = "";
  private readonly renderComponent: Component = new Component();
  private readonly messages: MessageBlock[] = [];
  private streamAbort: AbortController | null = null;
  /**
   * Held reference to the live SSE stream so `onClose` can call `close()` on
   * the producer in addition to aborting the consumer-side AbortController.
   * Aborting only kills the iterator; the EventStream's underlying fetch
   * lives until close() lands.
   */
  private currentStream: EventStream | null = null;
  /**
   * Current run id, set via `setRunContext`. Cached so `onClose` can
   * unregister the run from the plugin-level active-run registry.
   */
  private currentRunId: string | null = null;
  /**
   * Hook back to the plugin so the chat view can drive the active-run
   * registry. Optional — `setRunContext` populates it; standalone replay
   * sessions leave it null.
   */
  private pluginRef: {
    registerActiveRun: (
      runId: string,
      stream: EventStream,
      cleanup: () => void,
    ) => void;
    unregisterActiveRun: (runId: string) => void;
  } | null = null;
  // fs-bridge: instantiated when the chat view is bound to a run via
  // `setRunContext`. Null before a run is attached and after `onClose`
  // drains pending requests in `teardown()`. See docs/FS-BRIDGE-SPEC.md.
  private fsHandler: FsBridgeHandler | null = null;
  // Queue of fs.* events that arrived before `setRunContext` ran. Flushed
  // once the handler is constructed.
  private readonly pendingFsEvents: (
    | Extract<Event, { type: "fs.read_request" }>
    | Extract<Event, { type: "fs.write_request" }>
  )[] = [];
  /**
   * Tracks toolIds for which the user has already answered a
   * `tool.approval_required` event. Repeat events with the same toolId are
   * dropped silently — the server may resend on reconnect, but the local
   * decision is binding for the run lifetime.
   */
  private readonly decidedToolIds = new Set<string>();
  /**
   * Vault-relative workspace folder used by the artifact-path validator.
   * Defaults to `"Feynman/"` so unset-context views still get a sane
   * sandbox; the workflow runner overrides via `setWorkspaceFolder` once
   * settings are loaded.
   */
  private workspaceFolder = "Feynman/";
  /**
   * Whether (and how many) artifacts to auto-open in new panes when a run
   * finishes. Sourced from settings via `setAutoOpenArtifacts` — falls back
   * to "off" so a view not wired up by the workflow runner is a no-op.
   */
  private autoOpenArtifacts: "off" | "last" | "all" = "off";
  /**
   * When true, `tool.approval_required` and `agent.question` events get an
   * immediate positive answer and a chat-log breadcrumb instead of opening
   * a modal. The plugin has no persistent chat surface, so blocking on
   * user input would leave runs hung in the background.
   */
  private autoApproveAgentPrompts = false;
  /**
   * Live status banner at the top of the chat view. Shows what the agent
   * is doing right now (thinking, calling a tool, streaming a response,
   * waiting for the user) plus elapsed time. Replaces the silent
   * "empty pane until the first markdown chunk arrives" UX.
   */
  private statusEl: HTMLElement | null = null;
  private statusDotEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private statusDetailEl: HTMLElement | null = null;
  private statusTimerEl: HTMLElement | null = null;
  private statusTimerHandle: number | null = null;
  private statusRunStartedAt = 0;
  /**
   * Called once when the run terminates (run.done / run.error / aborted).
   * Hook for callers like the workflows sidebar that want to keep their
   * "Running…" button label live until the stream actually finishes.
   */
  private onRunFinished:
    | ((status: "done" | "error" | "aborted") => void)
    | null = null;
  /**
   * Artifact paths surfaced via `artifact.written` during the current run.
   * Used by the "Run complete" callout to list every file the agent
   * produced. Cleared on view close.
   */
  private readonly runArtifacts: string[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_FEYNMAN_CHAT;
  }

  override getDisplayText(): string {
    return "Feynman chat";
  }

  override getIcon(): string {
    return "messages-square";
  }

  /** Hook the chat view up to a transport. Called from the commands layer. */
  setInputPoster(poster: InputPoster): void {
    this.inputPoster = poster;
  }

  /** Register a one-shot callback fired when the current run terminates.
   * Called by the workflow runner so the sidebar's "Running /<slug>…" button
   * keeps its label until the SSE stream actually closes. */
  setOnRunFinished(cb: (status: "done" | "error" | "aborted") => void): void {
    this.onRunFinished = cb;
  }

  /**
   * Set the vault-relative workspace folder used by the artifact-path
   * validator. Should be called by the workflow runner alongside
   * `setInputPoster`. Defaults to `"Feynman/"`.
   */
  setWorkspaceFolder(folder: string): void {
    if (typeof folder === "string" && folder.length > 0) {
      this.workspaceFolder = folder;
    }
  }

  /** Configure auto-open behavior for the next run.done. */
  setAutoOpenArtifacts(mode: "off" | "last" | "all"): void {
    this.autoOpenArtifacts = mode;
  }

  /** Toggle auto-yes for `tool.approval_required` and `agent.question`. */
  setAutoApproveAgentPrompts(enabled: boolean): void {
    this.autoApproveAgentPrompts = enabled;
  }

  /**
   * Bind the chat view to a run so the fs-bridge handler can service
   * `fs.read_request` / `fs.write_request` events. Called by the workflow
   * runner alongside `setInputPoster`. `initialAllowlist` carries paths the
   * manifest declared as writable without approval (empty by default until
   * the protocol surfaces such a field).
   *
   * If fs.* events arrived before this setter ran (an unusual but possible
   * ordering — the SSE stream is attached separately), they are queued and
   * drained here.
   */
  setRunContext(runId: string, initialAllowlist: ReadonlySet<string>): void {
    if (this.inputPoster === null) {
      // Defensive: the workflow runner sets the poster first, but if it
      // hasn't, we can't service fs.* anyway. Bail without constructing the
      // handler so the next setter call wins.
      return;
    }
    const poster = this.inputPoster;
    this.currentRunId = runId;
    this.fsHandler = new FsBridgeHandler({
      app: this.app,
      runId,
      initialAllowlist,
      inputPoster: poster,
      requestWriteApproval: (path: string) =>
        this.askWriteApproval(runId, path),
    });
    // Drain any fs.* events that arrived before binding.
    const queued = this.pendingFsEvents.splice(0);
    for (const ev of queued) this.dispatchFsEvent(ev);
  }

  /**
   * Attach the chat view to the plugin's active-run registry. The
   * workflow-runner calls this with a reference to the plugin so the view
   * can register / unregister streams as they open and close. Decoupled
   * via an interface so this file doesn't import the plugin class.
   */
  setPluginRef(ref: {
    registerActiveRun: (
      runId: string,
      stream: EventStream,
      cleanup: () => void,
    ) => void;
    unregisterActiveRun: (runId: string) => void;
  }): void {
    this.pluginRef = ref;
  }

  override async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] ?? this.containerEl;
    const root = (container as HTMLElement);
    root.empty();
    root.addClass("feynman-chat-view");
    this.statusEl = root.createDiv({ cls: "feynman-chat-status is-idle" });
    const inner = this.statusEl.createDiv({ cls: "feynman-chat-status-inner" });
    this.statusDotEl = inner.createSpan({ cls: "feynman-chat-status-dot" });
    const labelWrap = inner.createDiv({ cls: "feynman-chat-status-label-wrap" });
    this.statusLabelEl = labelWrap.createSpan({
      cls: "feynman-chat-status-label",
      text: "Idle",
    });
    this.statusDetailEl = labelWrap.createSpan({
      cls: "feynman-chat-status-detail",
    });
    this.statusTimerEl = inner.createSpan({ cls: "feynman-chat-status-timer" });
    // "Clear" button — wipes the log so prior runs don't bleed into the
    // current one. Doesn't cancel an in-flight stream (use Cancel for that);
    // just removes the visible history. Auto-clear on the next attachStream
    // also runs, so a fresh /run starts with a clean view.
    const clearBtn = inner.createEl("button", {
      cls: "feynman-chat-clear-btn",
      text: "Clear",
      attr: { type: "button", title: "Clear run log" },
    });
    this.registerDomEvent(clearBtn, "click", () => this.clearLog());
    this.logEl = root.createDiv({ cls: "feynman-chat-log" });
    this.renderComponent.load();
  }

  override async onClose(): Promise<void> {
    if (this.streamAbort !== null) {
      this.streamAbort.abort();
      this.streamAbort = null;
    }
    // Close the producer side of the SSE stream — the AbortController above
    // only kills the consumer iterator; without an explicit close() the
    // underlying fetch leaks until the AbortController GCs.
    if (this.currentStream !== null) {
      try {
        this.currentStream.close();
      } catch {
        // ignore — close is idempotent on the typed contract
      }
      this.currentStream = null;
    }
    // Drain pending fs.* requests so the server isn't left waiting on a
    // response that will never come. See docs/FS-BRIDGE-SPEC.md
    // ("Vault unload behavior").
    if (this.fsHandler !== null) {
      await this.fsHandler.teardown();
      this.fsHandler = null;
    }
    if (this.pluginRef !== null && this.currentRunId !== null) {
      this.pluginRef.unregisterActiveRun(this.currentRunId);
    }
    this.currentRunId = null;
    this.pendingFsEvents.length = 0;
    for (const m of this.messages) {
      if (m.idle !== null) {
        m.idle.cancel();
        m.idle = null;
      }
    }
    this.messages.length = 0;
    this.runArtifacts.length = 0;
    this.stopStatusTimer();
    if (this.onRunFinished !== null) {
      const cb = this.onRunFinished;
      this.onRunFinished = null;
      cb("aborted");
    }
    this.renderComponent.unload();
  }

  /**
   * Drive the view from an SSE iterator. Iterates until `done`, the stream
   * surfaces a terminal event, or the view is closed. When the caller passes
   * the underlying `EventStream` (not just an AsyncIterable), the view
   * remembers it so `onClose` can also `stream.close()` the producer.
   */
  async attachStream(stream: AsyncIterable<Event> | EventStream): Promise<void> {
    if (this.streamAbort !== null) {
      this.streamAbort.abort();
    }
    // Auto-clear the visible log when a new run attaches so prior-run content
    // doesn't bleed into the current view. The manual "Clear" button covers
    // the case where the user wants to wipe mid-run.
    this.clearLog({ resetStatus: false });
    this.streamAbort = new AbortController();
    const signal = this.streamAbort.signal;
    // Stash the closable producer if the caller handed us a full EventStream.
    if (
      typeof (stream as { close?: () => void }).close === "function"
    ) {
      this.currentStream = stream as EventStream;
    }
    this.setRunningStatus("Connecting…", "");
    let finalStatus: "done" | "error" | "aborted" = "aborted";
    try {
      for await (const ev of stream) {
        if (signal.aborted) return;
        if (ev.type === "run.done") finalStatus = "done";
        else if (ev.type === "run.error") finalStatus = "error";
        this.ingest(ev);
      }
    } catch (err) {
      // Surface read errors as a terminal callout — these are transport
      // failures the SSE reader couldn't recover from.
      this.appendErrorCallout(
        err instanceof Error ? err.message : String(err),
        "stream-error",
      );
      finalStatus = "error";
      this.setTerminalStatus("error", "Stream interrupted");
    } finally {
      // Producer is exhausted (or aborted) — unregister so plugin onunload
      // doesn't try to cancel a finished run.
      if (this.pluginRef !== null && this.currentRunId !== null) {
        this.pluginRef.unregisterActiveRun(this.currentRunId);
      }
      this.stopStatusTimer();
      const cb = this.onRunFinished;
      this.onRunFinished = null;
      cb?.(finalStatus);
    }
  }

  /** Single entry point for SSE events; covers every `EventPayload` variant. */
  ingest(event: Event): void {
    switch (event.type) {
      case "agent.message":
        this.setRunningStatus("Responding", "");
        this.handleAgentMessage(event);
        break;
      case "agent.thinking":
        this.setRunningStatus("Thinking", "");
        this.handleThinking(event);
        break;
      case "agent.question":
        this.setRunningStatus("Waiting for input", "Question pending");
        this.handleQuestion(event);
        break;
      case "tool.call":
        this.setRunningStatus("Running tool", event.name);
        this.handleToolCall(event);
        break;
      case "tool.result":
        this.setRunningStatus("Processing result", "");
        this.handleToolResult(event);
        break;
      case "tool.approval_required":
        this.setRunningStatus("Waiting for approval", event.title);
        this.handleApprovalRequired(event);
        break;
      case "fs.read_request":
      case "fs.write_request":
        this.setRunningStatus(
          event.type === "fs.read_request" ? "Reading vault" : "Writing to vault",
          event.path,
        );
        // Handed off to FsBridgeHandler (§6.2, §6.3 + docs/FS-BRIDGE-SPEC.md).
        // The chat view shows a faint trace so the user knows real-time
        // vault access happened; the handler validates + executes + replies
        // via the input poster.
        this.appendDebugLine(
          event.type === "fs.read_request"
            ? `fs.read ${event.path}`
            : `fs.write ${event.path} (${event.content.length} bytes)`,
        );
        this.dispatchFsEvent(event);
        break;
      case "artifact.written":
        this.setRunningStatus("Writing artifact", event.path);
        this.handleArtifactWritten(event);
        break;
      case "run.error":
        this.setTerminalStatus("error", event.message);
        this.appendErrorCallout(event.message, event.code);
        // Finalize any open message so users don't see a half-rendered block.
        this.closeAllOpenMessages();
        break;
      case "run.done":
        this.setTerminalStatus(
          "done",
          event.exitCode === 0 ? "Run complete" : `Exit ${event.exitCode}`,
        );
        this.appendDoneCallout(event.exitCode, event.summary);
        this.closeAllOpenMessages();
        break;
      default: {
        // Exhaustiveness check; if a new variant lands in protocol, surface
        // it as plain text rather than silently dropping.
        const exhaustive: never = event;
        void exhaustive;
        break;
      }
    }
  }

  // -------------------------------------------------------------------
  // Per-event handlers
  // -------------------------------------------------------------------

  private handleAgentMessage(
    ev: Extract<Event, { type: "agent.message" }>,
  ): void {
    // Each `agent.message` event is treated as a delta for the most recent
    // open assistant message; if the last block is closed (or absent) we
    // start a new one. §8.2 specifies one chat block per message.
    const last = this.lastOpenAssistantMessage();
    if (last !== null) {
      last.markdown += ev.markdown;
      this.renderStreaming(last);
      this.scheduleIdleRender(last);
      return;
    }
    const block = this.createMessageBlock(ev.role);
    block.markdown = ev.markdown;
    this.renderStreaming(block);
    this.scheduleIdleRender(block);
  }

  private handleThinking(
    ev: Extract<Event, { type: "agent.thinking" }>,
  ): void {
    const target =
      this.lastOpenAssistantMessage() ?? this.lastAssistantMessage();
    if (target === null) {
      // No message yet — start one so the thinking has somewhere to live.
      const block = this.createMessageBlock("assistant");
      this.appendThinking(block, ev.markdown);
      return;
    }
    this.appendThinking(target, ev.markdown);
  }

  private handleToolCall(ev: Extract<Event, { type: "tool.call" }>): void {
    if (this.logEl === null) return;
    const details = this.logEl.createEl("details", {
      cls: "feynman-tool-call",
    });
    details.dataset["toolId"] = ev.toolId;
    const summary = details.createEl("summary");
    // Inline aria-hidden glyph so screen readers don't announce the
    // decorative arrow; the pseudo-element rule that previously injected this
    // was theme-fragile (a11y review §K).
    const arrow = summary.createSpan({ cls: "feynman-tool-arrow", text: "›" });
    arrow.setAttr("aria-hidden", "true");
    summary.createSpan({ text: `Tool: ${ev.name}` });
    const argsEl = details.createEl("pre", { cls: "feynman-tool-args" });
    argsEl.setText(this.previewArgs(ev.args));
  }

  private handleToolResult(
    ev: Extract<Event, { type: "tool.result" }>,
  ): void {
    if (this.logEl === null) return;
    const existing = this.logEl.querySelector(
      `details.feynman-tool-call[data-tool-id="${CSS.escape(ev.toolId)}"]`,
    );
    const host =
      existing instanceof HTMLElement
        ? existing
        : this.logEl.createEl("details", { cls: "feynman-tool-call" });
    const resultEl = host.createEl("div", {
      cls: ev.ok ? "feynman-tool-result-ok" : "feynman-tool-result-err",
    });
    // aria-hidden glyph replaces the prior CSS ::before content so screen
    // readers don't announce the decorative check / cross alongside the OK
    // / ERR text.
    const glyph = resultEl.createSpan({
      cls: "feynman-tool-glyph",
      text: ev.ok ? "✓" : "✗",
    });
    glyph.setAttr("aria-hidden", "true");
    resultEl.createSpan({ text: ev.ok ? "OK" : "ERR" });
    if (ev.preview !== undefined) {
      const pre = host.createEl("pre", { cls: "feynman-tool-preview" });
      pre.setText(ev.preview);
    }
  }

  private handleApprovalRequired(
    ev: Extract<Event, { type: "tool.approval_required" }>,
  ): void {
    // Dedupe: the server may resend `tool.approval_required` on reconnect,
    // but the user's decision is binding for the lifetime of the run. Drop
    // any repeat for a toolId we've already answered so we don't surface
    // a second modal asking the same question.
    if (this.decidedToolIds.has(ev.toolId)) return;
    const decide = async (decision: ApprovalDecision): Promise<void> => {
      this.decidedToolIds.add(ev.toolId);
      if (this.inputPoster === null) {
        new Notice("Feynman: no transport bound; cannot post approval");
        return;
      }
      try {
        await this.inputPoster(
          ToolApprovalModal.toInput(ev.toolId, decision),
        );
      } catch (err) {
        new Notice(
          `Feynman: approval failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    if (this.autoApproveAgentPrompts) {
      this.appendAutoAcceptCallout(`Auto-approved: ${ev.title}`);
      void decide("allow_once");
      return;
    }
    new ToolApprovalModal(
      this.app,
      { toolId: ev.toolId, title: ev.title, args: ev.args },
      (decision) => {
        void decide(decision);
      },
    ).open();
  }

  private handleArtifactWritten(
    ev: Extract<Event, { type: "artifact.written" }>,
  ): void {
    if (this.logEl === null) return;
    // Validate the server-supplied path against the workspace folder. Reject
    // empty, absolute, scheme-prefixed, or `..`-containing paths; require
    // the resolved path to still sit under `workspaceFolder`. If validation
    // fails we render a flat error line and never construct an <a href>.
    const validated = validateArtifactPath(ev.path, this.workspaceFolder);
    if (validated === null) {
      this.appendDebugLine(
        `artifact.written rejected (invalid path): ${ev.path.slice(0, 80)}`,
      );
      return;
    }
    if (!this.runArtifacts.includes(validated)) {
      this.runArtifacts.push(validated);
    }
    const callout = this.logEl.createDiv({
      cls: "feynman-artifact callout",
      attr: { "data-callout": "info" },
    });
    callout.createSpan({ text: "Artifact: " });
    // `href="#"` is deliberate: we never let the agent control the rendered
    // href attribute. Click-through goes through openLinkText on the
    // validated path only.
    const link = callout.createEl("a", {
      text: validated,
      cls: "internal-link",
      href: "#",
    });
    this.registerDomEvent(link, "click", (e: MouseEvent) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(validated, "", false);
    });
    callout.createSpan({ text: ` (${ev.bytes} bytes)` });
  }

  private handleQuestion(ev: AgentQuestionEvent): void {
    if (this.logEl === null) return;
    if (this.autoApproveAgentPrompts) {
      // No persistent chat UI → free-text questions like "proceed with this
      // plan?" get an immediate "yes". The agent's prompt is shown in a
      // breadcrumb so the user knows what was implicitly accepted.
      this.appendAutoAcceptCallout(
        `Auto-answered "yes": ${this.truncate(ev.markdown, 120)}`,
      );
      if (this.inputPoster !== null) {
        const answer: Input = {
          type: "answer",
          questionId: ev.questionId,
          markdown: "yes",
        };
        void this.inputPoster(answer).catch((err: unknown) => {
          new Notice(
            `Feynman: auto-answer failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return;
    }
    const callout = this.logEl.createDiv({
      cls: "feynman-question callout",
      attr: { "data-callout": "question" },
    });
    const promptEl = callout.createDiv({ cls: "feynman-question-prompt" });
    // Questions are user-facing prose; sanitize before render. The sentinel
    // sourcePath prevents wiki-link resolution against the vault root.
    void MarkdownRenderer.render(
      this.app,
      sanitizeAgentMarkdown(ev.markdown),
      promptEl,
      VIRTUAL_SOURCE_PATH,
      this.renderComponent,
    );
    const form = callout.createEl("form", { cls: "feynman-question-form" });
    const textarea = form.createEl("textarea", {
      cls: "feynman-question-input",
      attr: { rows: "3", placeholder: "Your answer (markdown)..." },
    });
    const btn = form.createEl("button", {
      text: "Send answer",
      attr: { type: "submit" },
    });
    this.registerDomEvent(form, "submit", (e: SubmitEvent) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (text.length === 0) return;
      if (this.inputPoster === null) {
        new Notice("Feynman: no transport bound; cannot post answer");
        return;
      }
      btn.setAttr("disabled", "true");
      const answer: Input = {
        type: "answer",
        questionId: ev.questionId,
        markdown: text,
      };
      void this.inputPoster(answer)
        .then(() => {
          textarea.setAttr("disabled", "true");
          callout.createDiv({
            cls: "feynman-question-sent",
            text: "Answer sent.",
          });
        })
        .catch((err: unknown) => {
          btn.removeAttribute("disabled");
          new Notice(
            `Feynman: answer failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  // -------------------------------------------------------------------
  // fs-bridge wiring (§6.2, §6.3; docs/FS-BRIDGE-SPEC.md)
  // -------------------------------------------------------------------

  /**
   * Route an fs.* event to the handler, or queue it if `setRunContext`
   * hasn't run yet. The queue is drained on bind.
   */
  private dispatchFsEvent(
    ev:
      | Extract<Event, { type: "fs.read_request" }>
      | Extract<Event, { type: "fs.write_request" }>,
  ): void {
    if (this.fsHandler === null) {
      this.pendingFsEvents.push(ev);
      return;
    }
    const handler = this.fsHandler;
    if (ev.type === "fs.read_request") {
      void handler.handleReadRequest(ev);
    } else {
      void handler.handleWriteRequest(ev);
    }
  }

  /**
   * Bridge a write-path approval request to the redesigned
   * `ToolApprovalModal`. Returns true on Allow / Allow once, false on Deny
   * (and on close-without-decide, which the modal already maps to Deny).
   */
  private askWriteApproval(runId: string, path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Synthesise a tool-approval shape the modal already understands.
      // Using a stable per-(run, path) toolId so the server-side dedupe
      // contract (§5.4) collapses double-clicks on the same request.
      const toolId = `fs.write:${runId}:${path}`;
      new ToolApprovalModal(
        this.app,
        {
          toolId,
          title: `Allow agent to write to "${path}"?`,
          args: { path },
        },
        (decision: ApprovalDecision) => {
          resolve(decision !== "deny");
        },
      ).open();
    });
  }

  // -------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------

  private createMessageBlock(role: "assistant" | "system"): MessageBlock {
    if (this.logEl === null) {
      throw new Error("chat view: log element not initialized");
    }
    const el = this.logEl.createDiv({
      cls: `feynman-message feynman-message-${role}`,
    });
    el.createDiv({ cls: "feynman-message-role", text: role });
    const bodyEl = el.createDiv({ cls: "feynman-message-body" });
    const pre = bodyEl.createEl("pre", { cls: "feynman-message-stream" });
    pre.setText("");
    const block: MessageBlock = {
      el,
      bodyEl,
      thinkingEl: null,
      markdown: "",
      thinkingMarkdown: "",
      idle: null,
      rendered: false,
      closed: false,
    };
    this.messages.push(block);
    return block;
  }

  private renderStreaming(block: MessageBlock): void {
    // Re-set the <pre> contents on every delta — cheap and avoids any
    // markdown work during streaming, per §8.2.
    const pre = block.bodyEl.querySelector("pre.feynman-message-stream");
    if (pre instanceof HTMLElement) {
      pre.setText(block.markdown);
    } else {
      const p = block.bodyEl.createEl("pre", { cls: "feynman-message-stream" });
      p.setText(block.markdown);
    }
  }

  /**
   * Coalesce streaming `agent.message` deltas. Each delta updates the raw
   * <pre> buffer (cheap), and we schedule one MarkdownRenderer.render at the
   * next idle boundary instead of re-rendering per delta (O(n²) reflow).
   * If a render is already pending, we leave it — the closure reads
   * `block.markdown` fresh when it fires.
   */
  private scheduleIdleRender(block: MessageBlock): void {
    if (block.idle !== null) return;
    block.idle = scheduleIdleRender(() => {
      block.idle = null;
      this.renderFinal(block);
    });
  }

  private renderFinal(block: MessageBlock): void {
    block.bodyEl.empty();
    const target = block.bodyEl.createDiv({ cls: "feynman-message-rendered" });
    // §8.2 says use `MarkdownRenderer.render`. Sanitize the agent-supplied
    // markdown before rendering; pass the virtual sourcePath so wiki-link
    // resolution doesn't anchor at the vault root.
    void MarkdownRenderer.render(
      this.app,
      sanitizeAgentMarkdown(block.markdown),
      target,
      VIRTUAL_SOURCE_PATH,
      this.renderComponent,
    );
    block.rendered = true;
  }

  private appendThinking(block: MessageBlock, delta: string): void {
    if (block.thinkingEl === null) {
      const details = block.el.createEl("details", {
        cls: "feynman-thinking",
      });
      details.createEl("summary", { text: "Thinking" });
      const pre = details.createEl("pre", { cls: "feynman-thinking-body" });
      block.thinkingEl = pre;
    }
    block.thinkingMarkdown += delta;
    block.thinkingEl.setText(block.thinkingMarkdown);
  }

  private appendDebugLine(text: string): void {
    if (this.logEl === null) return;
    const line = this.logEl.createDiv({ cls: "feynman-debug-line" });
    line.setText(text);
  }

  /**
   * Wipe the visible run log and associated per-run state. Called both from
   * the user's "Clear" button and automatically on the next `attachStream`
   * so a fresh run doesn't render alongside the previous one's history.
   *
   * Does NOT cancel any in-flight SSE stream — that lives in `streamAbort`
   * and is controlled by Cancel / view close. Clearing while a stream is
   * live just empties the visible log; new events stream in from a clean
   * starting point.
   */
  private clearLog(opts: { resetStatus?: boolean } = {}): void {
    const resetStatus = opts.resetStatus ?? true;
    if (this.logEl !== null) this.logEl.empty();
    // Tear down per-message idle handles so we don't try to render into
    // elements that are no longer in the DOM.
    for (const m of this.messages) {
      if (m.idle !== null) {
        m.idle.cancel();
        m.idle = null;
      }
    }
    this.messages.length = 0;
    this.runArtifacts.length = 0;
    this.decidedToolIds.clear();
    if (resetStatus) {
      this.stopStatusTimer();
      if (this.statusEl !== null) {
        this.statusEl.removeClass("is-running", "is-done", "is-error");
        this.statusEl.addClass("is-idle");
      }
      this.statusLabelEl?.setText("Idle");
      this.statusDetailEl?.setText("");
      this.statusTimerEl?.setText("");
    }
  }

  /** Inline breadcrumb shown when the plugin auto-accepts an agent prompt
   * on the user's behalf. Faint styling — the run keeps going and the
   * user can scroll back to see exactly what was approved. */
  private appendAutoAcceptCallout(text: string): void {
    if (this.logEl === null) return;
    const line = this.logEl.createDiv({ cls: "feynman-auto-accept" });
    const glyph = line.createSpan({ cls: "feynman-auto-accept-glyph", text: "✓" });
    glyph.setAttr("aria-hidden", "true");
    line.createSpan({ text });
  }

  private truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n) + "…";
  }

  private appendErrorCallout(message: string, code?: string): void {
    if (this.logEl === null) return;
    const el = this.logEl.createDiv({
      cls: "feynman-callout feynman-callout-error callout",
      attr: { "data-callout": "error" },
    });
    // aria-hidden bullet — see styles.css notes on the prior ::before rule.
    const glyph = el.createSpan({ cls: "feynman-callout-glyph", text: "•" });
    glyph.setAttr("aria-hidden", "true");
    el.createDiv({ cls: "callout-title", text: code ? `Error (${code})` : "Error" });
    el.createDiv({ cls: "callout-content", text: message });
  }

  private appendDoneCallout(exitCode: number, summary?: string): void {
    if (this.logEl === null) return;
    const el = this.logEl.createDiv({
      cls: "feynman-callout feynman-callout-done callout",
      attr: { "data-callout": exitCode === 0 ? "success" : "warning" },
    });
    const glyph = el.createSpan({ cls: "feynman-callout-glyph", text: "•" });
    glyph.setAttr("aria-hidden", "true");
    el.createDiv({
      cls: "callout-title",
      text: exitCode === 0 ? "Run complete" : `Run finished (exit ${exitCode})`,
    });
    const body = el.createDiv({ cls: "callout-content" });

    // Artifact summary — the most useful single piece of info post-run.
    // Without this the user has to scroll back through the log to find
    // every `artifact.written` callout to learn where the docs landed.
    if (this.runArtifacts.length > 0) {
      const wrap = body.createDiv({ cls: "feynman-done-artifacts" });
      wrap.createDiv({
        cls: "feynman-done-artifacts-title",
        text: this.runArtifacts.length === 1
          ? "Wrote 1 file:"
          : `Wrote ${this.runArtifacts.length} files:`,
      });
      const list = wrap.createEl("ul", { cls: "feynman-done-artifacts-list" });
      for (const path of this.runArtifacts) {
        const li = list.createEl("li");
        const link = li.createEl("a", {
          text: path,
          cls: "internal-link",
          href: "#",
        });
        this.registerDomEvent(link, "click", (e: MouseEvent) => {
          e.preventDefault();
          void this.app.workspace.openLinkText(path, "", false);
        });
      }
      // Also fire a Notice so users who navigated away from the chat view
      // (or had it tucked into a sidebar) get a top-corner heads-up.
      const lead = this.runArtifacts[0];
      const tail = this.runArtifacts.length > 1
        ? ` (+${this.runArtifacts.length - 1} more)`
        : "";
      new Notice(`Feynman: run complete — ${lead}${tail}`, 6000);
      // Auto-open per settings. Only on successful runs so a partial /
      // errored run doesn't pop a half-written file in the user's face.
      if (exitCode === 0) {
        this.autoOpenAfterRun();
      }
    } else if (exitCode === 0) {
      new Notice("Feynman: run complete.", 4000);
    }

    if (summary !== undefined) {
      const summaryEl = body.createDiv({ cls: "feynman-done-summary" });
      // run.done summaries are agent-authored; sanitize + use the virtual
      // sourcePath like every other agent-markdown surface in this view.
      void MarkdownRenderer.render(
        this.app,
        sanitizeAgentMarkdown(summary),
        summaryEl,
        VIRTUAL_SOURCE_PATH,
        this.renderComponent,
      );
    }
  }

  // -------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------

  private lastOpenAssistantMessage(): MessageBlock | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && !m.closed) return m;
    }
    return null;
  }

  private lastAssistantMessage(): MessageBlock | null {
    const last = this.messages[this.messages.length - 1];
    return last ?? null;
  }

  private closeAllOpenMessages(): void {
    for (const m of this.messages) {
      if (m.closed) continue;
      if (m.idle !== null) {
        m.idle.cancel();
        m.idle = null;
      }
      if (!m.rendered && m.markdown.length > 0) {
        this.renderFinal(m);
      }
      m.closed = true;
    }
  }

  private previewArgs(args: unknown): string {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }

  // -------------------------------------------------------------------
  // Status banner
  // -------------------------------------------------------------------

  /**
   * Open one or more artifacts in new panes per the user's preference. Called
   * from `appendDoneCallout` only on successful runs. Opens in a NEW leaf
   * (third arg `true`) so the chat view stays visible alongside.
   *
   * We only auto-open files whose extension Obsidian will render meaningfully
   * (markdown / canvas / image). For everything else (bibtex, json, csv) the
   * user can click the link in the callout if they actually want it open.
   */
  private autoOpenAfterRun(): void {
    if (this.autoOpenArtifacts === "off") return;
    if (this.runArtifacts.length === 0) return;
    const targets =
      this.autoOpenArtifacts === "all"
        ? this.runArtifacts.slice()
        : [this.runArtifacts[this.runArtifacts.length - 1]];
    for (const path of targets) {
      if (!path || !isAutoOpenableExt(path)) continue;
      try {
        // `openLinkText(linktext, sourcePath, newLeaf)` — third arg true opens
        // in a new pane so the chat view stays put.
        void this.app.workspace.openLinkText(path, "", true);
      } catch {
        // openLinkText throws if the file doesn't exist yet (race between the
        // server's `artifact.written` event and the vault rescan). Silently
        // skip — the clickable link in the callout still works.
      }
    }
  }

  private setRunningStatus(label: string, detail: string): void {
    if (this.statusEl === null) return;
    this.statusEl.removeClass("is-idle", "is-done", "is-error");
    this.statusEl.addClass("is-running");
    this.statusLabelEl?.setText(label);
    this.statusDetailEl?.setText(detail);
    this.startStatusTimerIfNeeded();
  }

  private setTerminalStatus(
    kind: "done" | "error",
    detail: string,
  ): void {
    if (this.statusEl === null) return;
    this.statusEl.removeClass("is-idle", "is-running");
    this.statusEl.addClass(kind === "done" ? "is-done" : "is-error");
    this.statusLabelEl?.setText(kind === "done" ? "Complete" : "Error");
    this.statusDetailEl?.setText(detail);
    this.stopStatusTimer();
  }

  private startStatusTimerIfNeeded(): void {
    if (this.statusTimerHandle !== null) return;
    this.statusRunStartedAt = Date.now();
    const tick = (): void => {
      if (this.statusTimerEl === null) return;
      const elapsed = Date.now() - this.statusRunStartedAt;
      this.statusTimerEl.setText(formatElapsed(elapsed));
    };
    tick();
    this.statusTimerHandle = window.setInterval(tick, 1000);
  }

  private stopStatusTimer(): void {
    if (this.statusTimerHandle !== null) {
      window.clearInterval(this.statusTimerHandle);
      this.statusTimerHandle = null;
    }
  }
}

/** Extensions Obsidian renders natively in a workspace leaf. Other formats
 * (bibtex, json, csv, etc.) are still clickable in the run-complete callout —
 * we just don't auto-open them, since opening would land on a text-only fallback. */
const AUTO_OPEN_EXTS = new Set([
  "md",
  "canvas",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
]);

function isAutoOpenableExt(path: string): boolean {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = path.slice(dotIdx + 1).toLowerCase();
  return AUTO_OPEN_EXTS.has(ext);
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

