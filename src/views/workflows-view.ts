// The workflows launcher pane. Opened from the ribbon icon (or the
// "Feynman: Open workflows" command). Renders a curated set of workflow
// buttons; clicking one expands its prompt form inline below it. On Run,
// delegates to the shared workflow-runner.
//
// Curation: §10's M2 deliverable surfaces the highest-traffic workflows.
// All other prompts remain reachable via the command palette.

import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type {
  ManifestArg,
  ManifestEntry,
  ManifestResponse,
  VaultMode,
} from "../protocol";

import type { FeynmanClient } from "../transport/client";
import { runWorkflow, type ActiveRunRegistry } from "../workflow-runner";

export const VIEW_TYPE_FEYNMAN_WORKFLOWS = "feynman-workflows";

/**
 * Curated, ordered slugs the pane surfaces. The pane shows these even when
 * the server isn't reachable — disabled — so the UI doesn't disappear and
 * the user has somewhere to land before they configure a backend.
 */
const FEATURED_SLUGS: readonly string[] = [
  "deepresearch",
  "lit",
  "audit",
  "recipe",
  "review",
  "draft",
];

const FEATURED_FALLBACK_TITLES: Record<string, string> = {
  deepresearch: "Deep research",
  lit: "Literature review",
  audit: "Audit",
  recipe: "Recipe",
  review: "Review this paper",
  draft: "Draft",
};

export interface WorkflowsViewDeps {
  client: FeynmanClient;
  manifest: ManifestResponse | null;
  getVaultMode: () => VaultMode;
  getModel: () => string | undefined;
  /** Server health, refreshed by the host plugin. */
  serverOk: boolean;
  serverLabel: string;
  /**
   * Set when the most recent connection succeeded but the server's reported
   * version is below `MIN_SERVER_VERSION`. The pane renders a distinct error
   * banner separate from the generic "not connected" banner.
   */
  versionError?: string;
  /** Opens the plugin's settings tab. */
  openSettings: () => void;
  /** Active-run registry — passed through to runWorkflow. */
  registry?: ActiveRunRegistry;
  /** Last-Event-ID persistence sink — passed through to runWorkflow. */
  onLastEventIdAdvance?: (runId: string, eventId: string) => void;
}

type ArgValue = string | number | boolean;

export class FeynmanWorkflowsView extends ItemView {
  private getDeps: () => WorkflowsViewDeps;
  private expanded: string | null = null;
  private readonly values: Map<string, Map<string, ArgValue>> = new Map();

  constructor(leaf: WorkspaceLeaf, getDeps: () => WorkflowsViewDeps) {
    super(leaf);
    this.getDeps = getDeps;
  }

  override getViewType(): string {
    return VIEW_TYPE_FEYNMAN_WORKFLOWS;
  }

  override getDisplayText(): string {
    return "Feynman";
  }

  override getIcon(): string {
    return "atom";
  }

  override async onOpen(): Promise<void> {
    this.render();
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Re-render — call when settings or manifest change in the host plugin. */
  rerender(): void {
    this.render();
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  private render(): void {
    const deps = this.getDeps();
    const root = this.contentEl;
    root.empty();
    root.addClass("feynman-pane");

    this.renderHead(root, deps);
    this.renderBody(root, deps);
    this.renderFoot(root, deps);
  }

  private renderHead(root: HTMLElement, deps: WorkflowsViewDeps): void {
    const head = root.createDiv({ cls: "feynman-pane-head" });

    const labelRow = head.createDiv({ cls: "feynman-pane-head-row" });
    labelRow.createSpan({ cls: "feynman-pane-label", text: "Feynman" });

    const spacer = labelRow.createSpan({ cls: "feynman-pane-spacer" });
    void spacer;

    const settingsBtn = labelRow.createEl("button", {
      cls: "feynman-pane-gear",
      attr: {
        type: "button",
        "aria-label": "Open Feynman settings",
        title: "Settings",
      },
    });
    setIcon(settingsBtn, "settings");
    this.registerDomEvent(settingsBtn, "click", () => deps.openSettings());

    const status = head.createDiv({ cls: "feynman-pane-status" });
    const dot = status.createSpan({
      cls: deps.serverOk
        ? "feynman-status-dot is-ok"
        : "feynman-status-dot is-down",
    });
    void dot;
    status.createSpan({ text: deps.serverLabel });
  }

  private renderBody(root: HTMLElement, deps: WorkflowsViewDeps): void {
    const body = root.createDiv({ cls: "feynman-pane-body" });

    // Version-skew banner — shown when the server is reachable but its
    // reported version is below the plugin's MIN_SERVER_VERSION. Separate
    // from the not-connected banner so the user knows the fix is "pull a
    // newer image", not "configure a backend".
    if (deps.versionError !== undefined && deps.versionError.length > 0) {
      const banner = body.createDiv({
        cls: "feynman-pane-banner feynman-pane-banner-version",
      });
      banner.createDiv({
        cls: "feynman-pane-banner-title",
        text: "Server version too old",
      });
      banner.createDiv({
        cls: "feynman-pane-banner-body",
        text: deps.versionError,
      });
      const configure = banner.createEl("button", {
        text: "Open settings",
        cls: "feynman-pane-banner-action mod-cta",
        attr: { type: "button" },
      });
      this.registerDomEvent(configure, "click", () => deps.openSettings());
    }

    // Not-connected banner — show whenever manifest is missing. Buttons
    // still render below, but disabled, so the layout doesn't shift after
    // the user wires up a backend.
    if (deps.manifest === null) {
      const banner = body.createDiv({ cls: "feynman-pane-banner" });
      banner.createDiv({
        cls: "feynman-pane-banner-title",
        text: "Not connected",
      });
      banner.createDiv({
        cls: "feynman-pane-banner-body",
        text: "Configure a backend to enable the workflows below.",
      });
      const configure = banner.createEl("button", {
        text: "Configure server",
        cls: "feynman-pane-banner-action mod-cta",
        attr: { type: "button" },
      });
      this.registerDomEvent(configure, "click", () => deps.openSettings());
    }

    if (deps.manifest === null) {
      // Disabled stub buttons matching the featured set so the UI shows
      // the user what's coming, not an empty box.
      for (const slug of FEATURED_SLUGS) {
        this.renderStubWorkflow(body, slug);
      }
      return;
    }

    const entries = this.featuredEntries(deps.manifest);

    if (entries.length === 0) {
      const empty = body.createDiv({ cls: "feynman-pane-empty" });
      empty.createDiv({
        cls: "feynman-pane-empty-title",
        text: "No featured workflows found.",
      });
      empty.createDiv({
        cls: "feynman-pane-empty-body",
        text: "All other prompts remain reachable via the command palette.",
      });
      return;
    }

    for (const entry of entries) {
      this.renderWorkflow(body, entry, deps);
    }
  }

  private renderStubWorkflow(host: HTMLElement, slug: string): void {
    const wf = host.createDiv({ cls: "feynman-wf is-disabled" });
    const btn = wf.createEl("button", {
      cls: "feynman-wf-btn",
      attr: {
        type: "button",
        disabled: "true",
        "aria-disabled": "true",
        title: "Configure a backend to enable",
      },
    });
    btn.createSpan({ cls: "feynman-wf-slash", text: `/${slug}` });
    btn.createSpan({
      cls: "feynman-wf-title",
      text: FEATURED_FALLBACK_TITLES[slug] ?? slug,
    });
    btn.createSpan({ cls: "feynman-wf-arrow", text: "›" });
  }

  private renderWorkflow(
    host: HTMLElement,
    entry: ManifestEntry,
    deps: WorkflowsViewDeps,
  ): void {
    const isOpen = this.expanded === entry.slug;
    const wf = host.createDiv({
      cls: isOpen ? "feynman-wf is-expanded" : "feynman-wf",
    });

    const btn = wf.createEl("button", {
      cls: "feynman-wf-btn",
      attr: {
        type: "button",
        "aria-expanded": isOpen ? "true" : "false",
      },
    });
    btn.createSpan({ cls: "feynman-wf-slash", text: `/${entry.slug}` });
    btn.createSpan({ cls: "feynman-wf-title", text: entry.title });
    btn.createSpan({ cls: "feynman-wf-arrow", text: "›" });

    this.registerDomEvent(btn, "click", () => {
      this.expanded = isOpen ? null : entry.slug;
      this.render();
    });

    if (isOpen) {
      this.renderPrompt(wf, entry, deps);
    }
  }

  private renderPrompt(
    host: HTMLElement,
    entry: ManifestEntry,
    deps: WorkflowsViewDeps,
  ): void {
    const prompt = host.createDiv({ cls: "feynman-wf-prompt" });

    if (entry.description.length > 0) {
      prompt.createDiv({
        cls: "feynman-wf-desc",
        text: entry.description,
      });
    }

    if (entry.context.length > 0) {
      const ctx = prompt.createDiv({ cls: "feynman-wf-ctx" });
      ctx.createSpan({ text: "uses" });
      entry.context.forEach((token, i) => {
        if (i > 0) ctx.createSpan({ text: "·" });
        ctx.createEl("strong", { text: token });
      });
    }

    if (!this.values.has(entry.slug)) {
      const seeded = new Map<string, ArgValue>();
      for (const arg of entry.args) {
        seeded.set(arg.name, arg.type === "boolean" ? false : "");
      }
      this.values.set(entry.slug, seeded);
    }
    const slugValues = this.values.get(entry.slug);
    if (slugValues === undefined) return;

    for (const arg of entry.args) {
      this.renderField(prompt, entry.slug, arg, slugValues);
    }

    const actions = prompt.createDiv({ cls: "feynman-wf-actions" });
    actions.createSpan({ cls: "feynman-wf-actions-spacer" });

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    this.registerDomEvent(cancelBtn, "click", () => {
      this.expanded = null;
      this.render();
    });

    const runBtn = actions.createEl("button", {
      cls: "feynman-wf-run mod-cta",
      text: `Run /${entry.slug}`,
      attr: { type: "button" },
    });
    this.registerDomEvent(runBtn, "click", () => {
      void this.runEntry(entry, slugValues, runBtn, deps);
    });
  }

  private renderField(
    host: HTMLElement,
    slug: string,
    arg: ManifestArg,
    values: Map<string, ArgValue>,
  ): void {
    const field = host.createDiv({ cls: "feynman-wf-field" });
    const label = field.createEl("label", { text: arg.name });
    const inputId = `feynman-${slug}-${arg.name}`;
    label.setAttr("for", inputId);

    if (arg.help !== undefined && arg.help.length > 0) {
      field.createDiv({ cls: "feynman-wf-help", text: arg.help });
    }

    const current = values.get(arg.name);

    switch (arg.type) {
      case "string": {
        const input = field.createEl("input", {
          attr: { id: inputId, type: "text" },
        });
        if (typeof current === "string") input.value = current;
        if (arg.required) input.setAttr("required", "true");
        this.registerDomEvent(input, "input", () =>
          values.set(arg.name, input.value),
        );
        break;
      }
      case "number": {
        const input = field.createEl("input", {
          attr: { id: inputId, type: "number" },
        });
        if (typeof current === "number") input.value = String(current);
        if (arg.required) input.setAttr("required", "true");
        this.registerDomEvent(input, "input", () => {
          const raw = input.value;
          const n = raw === "" ? "" : Number(raw);
          values.set(arg.name, typeof n === "number" && !Number.isNaN(n) ? n : "");
        });
        break;
      }
      case "boolean": {
        const wrap = field.createDiv({ cls: "feynman-wf-toggle" });
        const checkbox = wrap.createEl("input", {
          attr: { id: inputId, type: "checkbox" },
        });
        if (current === true) checkbox.checked = true;
        this.registerDomEvent(checkbox, "change", () =>
          values.set(arg.name, checkbox.checked),
        );
        break;
      }
      case "enum": {
        const select = field.createEl("select", {
          attr: { id: inputId },
        });
        const options = arg.enum ?? [];
        if (!arg.required) select.createEl("option", { attr: { value: "" } });
        for (const opt of options) {
          select.createEl("option", { text: opt, attr: { value: opt } });
        }
        if (typeof current === "string" && current.length > 0) {
          select.value = current;
        } else if (arg.required && options.length > 0) {
          const first = options[0] ?? "";
          select.value = first;
          values.set(arg.name, first);
        }
        this.registerDomEvent(select, "change", () =>
          values.set(arg.name, select.value),
        );
        break;
      }
      default: {
        const exhaustive: never = arg.type;
        void exhaustive;
        break;
      }
    }
  }

  private renderFoot(root: HTMLElement, deps: WorkflowsViewDeps): void {
    const foot = root.createDiv({ cls: "feynman-pane-foot" });
    const m = deps.manifest;
    if (m === null) {
      foot.createSpan({ text: "—" });
      return;
    }
    foot.createSpan({
      text: `${m.prompts.length} workflows · ${m.skills.length} skills`,
    });
  }

  // -------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------

  private featuredEntries(manifest: ManifestResponse): ManifestEntry[] {
    const bySlug = new Map(manifest.prompts.map((e) => [e.slug, e] as const));
    const out: ManifestEntry[] = [];
    for (const slug of FEATURED_SLUGS) {
      const entry = bySlug.get(slug);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  private async runEntry(
    entry: ManifestEntry,
    values: Map<string, ArgValue>,
    runBtn: HTMLButtonElement,
    deps: WorkflowsViewDeps,
  ): Promise<void> {
    const args: Record<string, unknown> = {};
    for (const arg of entry.args) {
      const v = values.get(arg.name);
      if (v === undefined || v === "" || v === null) {
        if (arg.required) {
          new Notice(`Feynman: ${arg.name} is required`);
          return;
        }
        continue;
      }
      args[arg.name] = v;
    }
    runBtn.setAttr("disabled", "true");
    runBtn.setText(`Running /${entry.slug}…`);
    try {
      await runWorkflow(this.app, entry, args, {
        client: deps.client,
        getVaultMode: deps.getVaultMode,
        getModel: deps.getModel,
        registry: deps.registry,
        onLastEventIdAdvance: deps.onLastEventIdAdvance,
      });
      this.expanded = null;
      this.render();
    } finally {
      runBtn.removeAttribute("disabled");
      runBtn.setText(`Run /${entry.slug}`);
    }
  }
}
