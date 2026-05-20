// Dynamic Obsidian command registration driven by /v1/manifest.
// See docs/ARCHITECTURE.md §8.1.
//
// For each ManifestEntry we register `feynman-<slug>` with name
// `Feynman: <title>…`. Invocation:
//   1. open a generic input modal rendering args by type;
//   2. delegate the rest (context capture, POST /v1/run, chat-view attach)
//      to the shared workflow-runner module.
//
// Also registers `feynman-open-chat` (open the chat view standalone) and
// `feynman-open-workflows` (open the workflows launcher pane).

import {
  App,
  Modal,
  Notice,
  Plugin,
  Setting,
} from "obsidian";
import type {
  ManifestArg,
  ManifestEntry,
  ManifestResponse,
  VaultMode,
} from "@feynman/protocol";

import type { FeynmanClient } from "../transport/client";
import { openChatLeaf, runWorkflow } from "../workflow-runner";
import {
  VIEW_TYPE_FEYNMAN_WORKFLOWS,
} from "../views/workflows-view";

export interface RegisterCommandsDeps {
  client: FeynmanClient;
  manifest: ManifestResponse;
  /** Returns the deployment mode the user has selected in settings. */
  getVaultMode: () => VaultMode;
  /** Returns the currently picked model id, or undefined for server default. */
  getModel: () => string | undefined;
}

export function registerCommands(
  plugin: Plugin,
  deps: RegisterCommandsDeps,
): void {
  const { client, manifest, getVaultMode, getModel } = deps;

  for (const entry of manifest.prompts) {
    plugin.addCommand({
      id: `feynman-${entry.slug}`,
      name: `Feynman: ${entry.title}…`,
      callback: () => {
        new PromptArgsModal(plugin.app, entry, async (args) => {
          await runWorkflow(plugin.app, entry, args, {
            client,
            getVaultMode,
            getModel,
          });
        }).open();
      },
    });
  }

  plugin.addCommand({
    id: "feynman-open-chat",
    name: "Feynman: Open chat",
    callback: () => {
      void openChatLeaf(plugin.app);
    },
  });

  plugin.addCommand({
    id: "feynman-open-workflows",
    name: "Feynman: Open workflows",
    callback: () => {
      void openWorkflowsLeaf(plugin);
    },
  });
}

async function openWorkflowsLeaf(plugin: Plugin): Promise<void> {
  const workspace = plugin.app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_FEYNMAN_WORKFLOWS);
  let leaf = existing[0] ?? null;
  if (leaf === null) {
    leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
    if (leaf !== null) {
      await leaf.setViewState({
        type: VIEW_TYPE_FEYNMAN_WORKFLOWS,
        active: true,
      });
    }
  }
  if (leaf !== null) workspace.revealLeaf(leaf);
}

// ---------------------------------------------------------------------
// Generic input modal (§8.1) — used by the command-palette flow.
// ---------------------------------------------------------------------

type ArgValue = string | number | boolean;

class PromptArgsModal extends Modal {
  private readonly entry: ManifestEntry;
  private readonly onSubmit: (args: Record<string, unknown>) => Promise<void>;
  private readonly values = new Map<string, ArgValue>();

  constructor(
    app: App,
    entry: ManifestEntry,
    onSubmit: (args: Record<string, unknown>) => Promise<void>,
  ) {
    super(app);
    this.entry = entry;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feynman-prompt-args-modal");
    contentEl.createEl("h2", { text: this.entry.title });
    if (this.entry.description.length > 0) {
      contentEl.createEl("p", {
        cls: "feynman-prompt-args-description",
        text: this.entry.description,
      });
    }

    for (const arg of this.entry.args) {
      if (arg.type === "boolean") this.values.set(arg.name, false);
      else this.values.set(arg.name, "");
    }

    for (const arg of this.entry.args) {
      this.renderArg(contentEl, arg);
    }

    const buttonsRow = contentEl.createDiv({ cls: "feynman-prompt-args-buttons" });
    const submitBtn = buttonsRow.createEl("button", {
      text: "Run",
      cls: "mod-cta",
    });
    const cancelBtn = buttonsRow.createEl("button", { text: "Cancel" });
    submitBtn.addEventListener("click", () => {
      void this.submit(submitBtn);
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderArg(host: HTMLElement, arg: ManifestArg): void {
    const setting = new Setting(host).setName(arg.name);
    if (arg.help !== undefined) setting.setDesc(arg.help);
    switch (arg.type) {
      case "string":
        setting.addText((t) => {
          t.setValue("");
          t.onChange((v) => this.values.set(arg.name, v));
          if (arg.required) t.inputEl.required = true;
        });
        break;
      case "number":
        setting.addText((t) => {
          t.inputEl.type = "number";
          t.onChange((v) => {
            const n = v === "" ? "" : Number(v);
            this.values.set(arg.name, Number.isNaN(n) ? "" : n);
          });
          if (arg.required) t.inputEl.required = true;
        });
        break;
      case "boolean":
        setting.addToggle((toggle) => {
          toggle.setValue(false);
          toggle.onChange((v) => this.values.set(arg.name, v));
        });
        break;
      case "enum":
        setting.addDropdown((dd) => {
          const options = arg.enum ?? [];
          if (!arg.required) dd.addOption("", "");
          for (const opt of options) dd.addOption(opt, opt);
          const first =
            !arg.required ? "" : (options[0] ?? "");
          dd.setValue(first);
          this.values.set(arg.name, first);
          dd.onChange((v) => this.values.set(arg.name, v));
        });
        break;
      default: {
        const exhaustive: never = arg.type;
        void exhaustive;
        break;
      }
    }
  }

  private async submit(submitBtn: HTMLButtonElement): Promise<void> {
    const out: Record<string, unknown> = {};
    for (const arg of this.entry.args) {
      const v = this.values.get(arg.name);
      if (v === undefined || v === "" || v === null) {
        if (arg.required) {
          new Notice(`Feynman: ${arg.name} is required`);
          return;
        }
        continue;
      }
      out[arg.name] = v;
    }
    submitBtn.setAttr("disabled", "true");
    try {
      await this.onSubmit(out);
      this.close();
    } catch (err) {
      submitBtn.removeAttribute("disabled");
      new Notice(
        `Feynman: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
