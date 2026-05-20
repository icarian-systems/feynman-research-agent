// Tool-approval modal. Opened by the chat view when a `tool.approval_required`
// event arrives (see docs/ARCHITECTURE.md §5.2, §8.2).

import { App, Modal } from "obsidian";
import type { Input } from "@feynman/protocol";

export type ApprovalDecision = "allow" | "allow_once" | "deny";

export type ApprovalRequest = {
  toolId: string;
  // Confirmation prompt — not a tool identifier. See protocol comment on
  // tool.approval_required.
  title: string;
  args: unknown;
};

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

    contentEl.createEl("h3", { text: this.request.title });
    contentEl.createEl("p", {
      cls: "feynman-tool-approval-id",
      text: `Request ID: ${this.request.toolId}`,
    });

    const argsLabel = contentEl.createEl("p", { text: "Arguments:" });
    argsLabel.addClass("feynman-tool-approval-args-label");
    const pre = contentEl.createEl("pre", { cls: "feynman-tool-approval-args" });
    try {
      pre.setText(JSON.stringify(this.request.args, null, 2));
    } catch {
      pre.setText(String(this.request.args));
    }

    const buttons = contentEl.createDiv({ cls: "feynman-tool-approval-buttons" });
    const allow = buttons.createEl("button", { text: "Allow", cls: "mod-cta" });
    const allowOnce = buttons.createEl("button", { text: "Allow once" });
    const deny = buttons.createEl("button", { text: "Deny", cls: "mod-warning" });

    allow.addEventListener("click", () => this.decide("allow"));
    allowOnce.addEventListener("click", () => this.decide("allow_once"));
    deny.addEventListener("click", () => this.decide("deny"));
  }

  private decide(decision: ApprovalDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecide(decision);
    this.close();
  }

  override onClose(): void {
    // If the user dismissed the modal without choosing, treat that as "deny"
    // so the run isn't left hanging waiting on an input that never comes.
    if (!this.decided) {
      this.decided = true;
      this.onDecide("deny");
    }
    this.contentEl.empty();
  }

  /** Convenience: turn a decision into the matching `Input` payload. */
  static toInput(toolId: string, decision: ApprovalDecision): Input {
    return { type: "approval", toolId, decision };
  }
}
