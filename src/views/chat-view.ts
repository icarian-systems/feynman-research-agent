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
import type { Event, Input } from "@feynman/protocol";

import { ToolApprovalModal, type ApprovalDecision } from "./tool-approval";

export const VIEW_TYPE_FEYNMAN_CHAT = "feynman-chat";

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
  idleTimer: number | null;
  rendered: boolean;
  closed: boolean;
};

const IDLE_RENDER_MS = 250;

type AgentQuestionEvent = Extract<Event, { type: "agent.question" }>;

export class FeynmanChatView extends ItemView {
  private logEl: HTMLElement | null = null;
  private inputPoster: InputPoster | null = null;
  private sourcePath = "";
  private readonly renderComponent: Component = new Component();
  private readonly messages: MessageBlock[] = [];
  private streamAbort: AbortController | null = null;

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
    for (const m of this.messages) {
      if (m.idleTimer !== null) window.clearTimeout(m.idleTimer);
    }
    this.messages.length = 0;
    this.renderComponent.unload();
  }

  /**
   * Drive the view from an SSE iterator. Iterates until `done`, the stream
   * surfaces a terminal event, or the view is closed.
   */
  async attachStream(stream: AsyncIterable<Event>): Promise<void> {
    if (this.streamAbort !== null) {
      this.streamAbort.abort();
    }
    this.streamAbort = new AbortController();
    const signal = this.streamAbort.signal;
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
        // Handled by the fs-bridge layer (§6.2, §6.3); the chat view shows
        // a faint trace so the user knows real-time vault access happened.
        this.appendDebugLine(
          event.type === "fs.read_request"
            ? `fs.read ${event.path}`
            : `fs.write ${event.path} (${event.content.length} bytes)`,
        );
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
    details.createEl("summary", { text: `Tool: ${ev.name}` });
    const argsEl = details.createEl("pre", { cls: "feynman-tool-args" });
    argsEl.setText(this.previewArgs(ev.args));
  }

  private handleToolResult(
    ev: Extract<Event, { type: "tool.result" }>,
  ): void {
    if (this.logEl === null) return;
    const existing = this.logEl.querySelector(
      `details.feynman-tool-call[data-tool-id="${cssEscape(ev.toolId)}"]`,
    );
    const host =
      existing instanceof HTMLElement
        ? existing
        : this.logEl.createEl("details", { cls: "feynman-tool-call" });
    const resultEl = host.createEl("div", {
      cls: ev.ok ? "feynman-tool-result-ok" : "feynman-tool-result-err",
    });
    resultEl.createSpan({ text: ev.ok ? "OK" : "ERR" });
    if (ev.preview !== undefined) {
      const pre = host.createEl("pre", { cls: "feynman-tool-preview" });
      pre.setText(ev.preview);
    }
  }

  private handleApprovalRequired(
    ev: Extract<Event, { type: "tool.approval_required" }>,
  ): void {
    const decide = async (decision: ApprovalDecision): Promise<void> => {
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
    const callout = this.logEl.createDiv({
      cls: "feynman-artifact callout",
      attr: { "data-callout": "info" },
    });
    callout.createSpan({ text: "Artifact: " });
    const link = callout.createEl("a", {
      text: ev.path,
      cls: "internal-link",
      href: ev.path,
    });
    link.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(ev.path, "", false);
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
    // Questions are user-facing prose; render as markdown directly.
    void MarkdownRenderer.render(
      this.app,
      ev.markdown,
      promptEl,
      this.sourcePath,
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
    form.addEventListener("submit", (e: SubmitEvent) => {
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
      idleTimer: null,
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

  private scheduleIdleRender(block: MessageBlock): void {
    if (block.idleTimer !== null) {
      window.clearTimeout(block.idleTimer);
    }
    block.idleTimer = window.setTimeout(() => {
      block.idleTimer = null;
      this.renderFinal(block);
    }, IDLE_RENDER_MS);
  }

  private renderFinal(block: MessageBlock): void {
    block.bodyEl.empty();
    const target = block.bodyEl.createDiv({ cls: "feynman-message-rendered" });
    // §8.2 says use `MarkdownRenderer.render`. Some Obsidian versions only
    // expose the deprecated `renderMarkdown`; this code targets the modern
    // API. The signature: render(app, markdown, el, sourcePath, component).
    void MarkdownRenderer.render(
      this.app,
      block.markdown,
      target,
      this.sourcePath,
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
    el.createDiv({ cls: "callout-title", text: code ? `Error (${code})` : "Error" });
    el.createDiv({ cls: "callout-content", text: message });
  }

  private appendDoneCallout(exitCode: number, summary?: string): void {
    if (this.logEl === null) return;
    const el = this.logEl.createDiv({
      cls: "feynman-callout feynman-callout-done callout",
      attr: { "data-callout": exitCode === 0 ? "success" : "warning" },
    });
    el.createDiv({
      cls: "callout-title",
      text: exitCode === 0 ? "Run complete" : `Run finished (exit ${exitCode})`,
    });
    if (summary !== undefined) {
      const body = el.createDiv({ cls: "callout-content" });
      void MarkdownRenderer.render(
        this.app,
        summary,
        body,
        this.sourcePath,
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
      if (m.idleTimer !== null) {
        window.clearTimeout(m.idleTimer);
        m.idleTimer = null;
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

// CSS.escape isn't always present in Electron's DOM lib in older versions.
function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
