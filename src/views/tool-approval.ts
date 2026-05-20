// Tool-approval modal. Opened by the chat view when a `tool.approval_required`
// event arrives (see docs/ARCHITECTURE.md §5.2, §8.2).
//
// Design contract (Agent 4, Wave 2 security review):
//   - Render the actual operation: bash commands in <code>, file paths in
//     <code>, anything else as truncated JSON in <pre>. Users must be able
//     to see what they're approving.
//   - Default-focused button is Deny. Escape dismisses as Deny. No
//     allow.focus() anywhere.
//   - Every decision (allow / allow_once / deny / dismiss) is appended to
//     `<vault>/Feynman/decisions.log` as a JSON line so the user can audit
//     after the fact.

import { App, Modal, Notice } from "obsidian";
import type { Input } from "../protocol";

export type ApprovalDecision = "allow" | "allow_once" | "deny";

export type ApprovalRequest = {
  toolId: string;
  // Confirmation prompt — not a tool identifier. See protocol comment on
  // tool.approval_required.
  title: string;
  args: unknown;
  /** Optional run id so the decision log can be cross-referenced later. */
  runId?: string;
};

/** Hard cap on JSON-args preview in the modal so a multi-MB blob doesn't
 * blow up the Obsidian renderer. The decisions.log records the toolId only,
 * not the full args. */
const ARGS_PREVIEW_MAX = 1000;

/**
 * Decision-log path inside the vault. Append-only; the modal creates the
 * parent folder on first write if missing. Format: one JSON object per
 * line, ndjson-style.
 */
const DECISIONS_LOG_PATH = "Feynman/decisions.log";

export class ToolApprovalModal extends Modal {
  private readonly request: ApprovalRequest;
  private readonly onDecide: (decision: ApprovalDecision) => void;
  private decided = false;

  constructor(
    app: App,
    request: ApprovalRequest,
    onDecide: (decision: ApprovalDecision) => void,
  ) {
    super(app);
    this.request = request;
    this.onDecide = onDecide;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feynman-tool-approval-modal");

    // Heading — request.title is operator-facing prose ("Allow ls -la?" or
    // "Approve write to Feynman/draft.md?"). Plain text only; never
    // re-rendered as markdown.
    contentEl.createEl("h3", { text: this.request.title });
    contentEl.createEl("p", {
      cls: "feynman-tool-approval-id",
      text: `Request ID: ${this.request.toolId}`,
    });

    // Operation rendering — the user has to see the actual command / path
    // they're authorizing. Three buckets:
    //   1. Bash-shaped args ({ command: string }) → <code> with the command.
    //   2. Path-shaped args ({ path: string }) → <code> with the path.
    //   3. Anything else → JSON-stringified, truncated, in <pre>.
    this.renderArgsPreview(contentEl);

    const buttons = contentEl.createDiv({
      cls: "feynman-tool-approval-buttons",
    });
    // Order matters for keyboard tab traversal: Deny is the safe default
    // and gets initial focus.
    const denyBtn = buttons.createEl("button", {
      text: "Deny",
      cls: "mod-warning",
    });
    const allowOnceBtn = buttons.createEl("button", { text: "Allow once" });
    const allowBtn = buttons.createEl("button", {
      text: "Allow",
      cls: "mod-cta",
    });

    // Modal isn't a Component, so we can't use registerDomEvent here. The
    // listeners live for the modal's lifetime; contentEl.empty() in onClose
    // drops the elements (and their listener refs) when the modal closes.
    denyBtn.addEventListener("click", () => this.decide("deny"));
    allowOnceBtn.addEventListener("click", () => this.decide("allow_once"));
    allowBtn.addEventListener("click", () => this.decide("allow"));

    // Default-deny posture: focus Deny so Enter dismisses safely. Per Agent
    // 4 spec we never call allow.focus().
    denyBtn.focus();
  }

  /**
   * Render the args block. Sniffs the shape to pick a presentation:
   *   - object with string `command` → bash-style code block
   *   - object with string `path`    → path code block
   *   - else                         → truncated JSON in <pre>
   * The chat-view shows the title; this surface shows the operation.
   */
  private renderArgsPreview(host: HTMLElement): void {
    const args = this.request.args;
    const argsLabel = host.createEl("p", { text: "Operation:" });
    argsLabel.addClass("feynman-tool-approval-args-label");

    if (args !== null && typeof args === "object") {
      const obj = args as Record<string, unknown>;
      if (typeof obj.command === "string" && obj.command.length > 0) {
        const code = host.createEl("code", {
          cls: "feynman-tool-approval-args",
        });
        code.setText(obj.command);
        return;
      }
      if (typeof obj.path === "string" && obj.path.length > 0) {
        const code = host.createEl("code", {
          cls: "feynman-tool-approval-args",
        });
        // Display the path as-given; vault root resolution happens at the
        // fs-bridge layer. The modal's job is to show the user what's
        // about to be touched, not to validate it (the chat-view path
        // validator does that on artifact.written, and fs-bridge enforces
        // the manifest allowlist).
        code.setText(obj.path);
        return;
      }
    }

    // Fallback — JSON-stringify and truncate. Larger args are common when
    // the tool takes structured inputs; we cap at ARGS_PREVIEW_MAX so the
    // modal stays readable.
    const pre = host.createEl("pre", { cls: "feynman-tool-approval-args" });
    let text: string;
    try {
      text = JSON.stringify(args, null, 2);
    } catch {
      text = String(args);
    }
    if (text.length > ARGS_PREVIEW_MAX) {
      text = text.slice(0, ARGS_PREVIEW_MAX) + "…";
    }
    pre.setText(text);
  }

  private decide(decision: ApprovalDecision): void {
    if (this.decided) return;
    this.decided = true;
    // Best-effort decision log write — failures must not block the actual
    // decision flow. Fire-and-forget; surface a Notice on error.
    void this.appendDecisionsLog(decision).catch((err: unknown) => {
      // Decisions log is best-effort audit only; surface as a low-noise
      // Notice rather than blowing up the modal.
      new Notice(
        `Feynman: decisions log write failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.onDecide(decision);
    this.close();
  }

  override onClose(): void {
    // If the user dismissed the modal without choosing (Escape, click
    // outside, etc.) treat that as "deny" so the run isn't left hanging
    // waiting on an input that never comes. decide() guards re-entry.
    if (!this.decided) {
      this.decided = true;
      void this.appendDecisionsLog("deny").catch(() => {
        // ignore — dismiss path already has no UI to surface the error.
      });
      this.onDecide("deny");
    }
    this.contentEl.empty();
  }

  /**
   * Append a single ndjson entry to `<vault>/Feynman/decisions.log`. Format:
   *   {"ts":"...","runId":"...","toolId":"...","tool":"...","decision":"..."}
   * Creates the parent folder if missing. Best-effort — any failure is
   * surfaced via Notice in decide() but the decision itself proceeds.
   */
  private async appendDecisionsLog(decision: ApprovalDecision): Promise<void> {
    const entry = {
      ts: new Date().toISOString(),
      runId: this.request.runId ?? "",
      toolId: this.request.toolId,
      tool: this.request.title,
      decision,
    };
    const line = JSON.stringify(entry) + "\n";
    const adapter = this.app.vault.adapter;

    // Ensure the parent folder exists. `mkdir` on the adapter is idempotent
    // — Obsidian's typing isn't super honest about that, so guard with a
    // try/catch on the exists check.
    try {
      const exists = await adapter.exists("Feynman");
      if (!exists) {
        await adapter.mkdir("Feynman");
      }
    } catch {
      // ignore — fall through and let the write attempt surface the error
    }

    // Prefer adapter.append (atomic on supported platforms); fall back to
    // read-modify-write if append isn't available on this Obsidian build.
    const adapterAny = adapter as unknown as {
      append?: (path: string, data: string) => Promise<void>;
    };
    if (typeof adapterAny.append === "function") {
      await adapterAny.append(DECISIONS_LOG_PATH, line);
      return;
    }
    let prior = "";
    try {
      prior = await adapter.read(DECISIONS_LOG_PATH);
    } catch {
      // File doesn't exist yet — first write.
    }
    await adapter.write(DECISIONS_LOG_PATH, prior + line);
  }

  /** Convenience: turn a decision into the matching `Input` payload. */
  static toInput(toolId: string, decision: ApprovalDecision): Input {
    return { type: "approval", toolId, decision };
  }
}
