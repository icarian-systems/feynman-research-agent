// Diagnose Docker modal. Reads from the supervisor's existing resolver and
// runDocker; displays a structured report and a "Copy" button so users can
// paste it into a support thread.

import { App, Modal, Notice } from "obsidian";

import {
  collectDiagnostics,
  formatDiagnosticsReport,
} from "../docker/diagnose";
import type { DockerSupervisor } from "../docker/supervisor";

export class DockerDiagnoseModal extends Modal {
  private readonly supervisor: DockerSupervisor;

  constructor(app: App, supervisor: DockerSupervisor) {
    super(app);
    this.supervisor = supervisor;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feynman-diagnose-modal");

    contentEl.createEl("h3", { text: "Docker diagnostics" });
    const status = contentEl.createEl("p", {
      cls: "feynman-diagnose-status",
      text: "Running diagnostics…",
    });

    void this.run(status);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async run(status: HTMLElement): Promise<void> {
    let text: string;
    try {
      const report = await collectDiagnostics(this.supervisor);
      text = formatDiagnosticsReport(report);
    } catch (err) {
      text = `Diagnostics failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    status.remove();
    this.renderReport(text);
  }

  private renderReport(text: string): void {
    const { contentEl } = this;
    const pre = contentEl.createEl("pre", { cls: "feynman-diagnose-report" });
    pre.setText(text);

    const buttons = contentEl.createDiv({ cls: "feynman-diagnose-buttons" });
    const copy = buttons.createEl("button", {
      text: "Copy report",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    const close = buttons.createEl("button", {
      text: "Close",
      attr: { type: "button" },
    });

    // Modal isn't a Component; bare addEventListener is fine — contentEl
    // is emptied on close, releasing handlers.
    copy.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(text)
        .then(() => new Notice("Feynman: diagnostics copied to clipboard."))
        .catch((err: unknown) => {
          new Notice(
            `Feynman: clipboard copy failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
    close.addEventListener("click", () => this.close());
  }
}
