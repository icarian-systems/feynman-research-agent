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
 * workspace folder. Returns null on reject (caller must drop the event).
 * Rules (Agent 4):
 *   - Empty path rejected.
 *   - Absolute path (`/...`) rejected.
 *   - Any `..` segment rejected.
 *   - Scheme prefixes rejected (http:, https:, file:, javascript:, data:).
 *   - After joining with `workspaceFolder`, the resolved string must still
 *     prefix-match the workspace folder (string check; no realpath available
 *     in Obsidian's adapter API).
 */
export function validateArtifactPath(
  rawPath: string,
  workspaceFolder: string,
): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  // Disallow scheme-prefixed paths — these would render as external links.
  if (/^(?:https?|file|javascript|data):/i.test(rawPath)) return null;
  // Absolute paths escape the vault — reject.
  if (rawPath.startsWith("/")) return null;
  // Any `..` segment is a traversal attempt; reject without trying to
  // canonicalize.
  if (rawPath.includes("..")) return null;

  const folder = workspaceFolder.endsWith("/")
    ? workspaceFolder
    : workspaceFolder + "/";
  // The agent may have already prefixed the path with the workspace folder
  // (server-side templating). Honor that — only re-prefix if missing.
  const resolved = rawPath.startsWith(folder) ? rawPath : folder + rawPath;
  if (!resolved.startsWith(folder)) return null;
  return resolved;
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
    this.streamAbort = new AbortController();
    const signal = this.streamAbort.signal;
    // Stash the closable producer if the caller handed us a full EventStream.
    if (
      typeof (stream as { close?: () => void }).close === "function"
    ) {
      this.currentStream = stream as EventStream;
    }
    try {
      for await (const ev of stream) {
        if (signal.aborted) return;
        this.ingest(ev);
      }
    } catch (err) {
      // Surface read errors as a terminal callout — these are transport
      // failures the SSE reader couldn't recover from.
      this.appendErrorCallout(
        err instanceof Error ? err.message : String(err),
        "stream-error",
      );
    } finally {
      // Producer is exhausted (or aborted) — unregister so plugin onunload
      // doesn't try to cancel a finished run.
      if (this.pluginRef !== null && this.currentRunId !== null) {
        this.pluginRef.unregisterActiveRun(this.currentRunId);
      }
    }
  }

  /** Single entry point for SSE events; covers every `EventPayload` variant. */
  ingest(event: Event): void {
    switch (event.type) {
      case "agent.message":
        this.handleAgentMessage(event);
        break;
      case "agent.thinking":
        this.handleThinking(event);
        break;
      case "agent.question":
        this.handleQuestion(event);
        break;
      case "tool.call":
        this.handleToolCall(event);
        break;
      case "tool.result":
        this.handleToolResult(event);
        break;
      case "tool.approval_required":
        this.handleApprovalRequired(event);
        break;
      case "fs.read_request":
      case "fs.write_request":
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
        this.handleArtifactWritten(event);
        break;
      case "run.error":
        this.appendErrorCallout(event.message, event.code);
        // Finalize any open message so users don't see a half-rendered block.
        this.closeAllOpenMessages();
        break;
      case "run.done":
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
    if (summary !== undefined) {
      const body = el.createDiv({ cls: "callout-content" });
      // run.done summaries are agent-authored; sanitize + use the virtual
      // sourcePath like every other agent-markdown surface in this view.
      void MarkdownRenderer.render(
        this.app,
        sanitizeAgentMarkdown(summary),
        body,
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
}

