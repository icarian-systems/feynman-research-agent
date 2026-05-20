// Feynman Obsidian plugin entry point.
//
// See docs/ARCHITECTURE.md §4.2 (plugin layout) and §8 (plugin UX).

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import type {
  ManifestResponse,
  VaultMode,
} from "@feynman/protocol";

import { FeynmanClient } from "./src/transport/client";
import { registerCommands } from "./src/commands/register";
import {
  FeynmanSettingTab,
  DEFAULT_SETTINGS,
  type FeynmanSettings,
} from "./src/settings/settings-tab";
import {
  FeynmanChatView,
  VIEW_TYPE_FEYNMAN_CHAT,
} from "./src/views/chat-view";
import {
  FeynmanArtifactView,
  VIEW_TYPE_FEYNMAN_ARTIFACTS,
} from "./src/views/artifact-view";
import {
  FeynmanWorkflowsView,
  VIEW_TYPE_FEYNMAN_WORKFLOWS,
  type WorkflowsViewDeps,
} from "./src/views/workflows-view";

export default class FeynmanPlugin extends Plugin {
  settings: FeynmanSettings = DEFAULT_SETTINGS;
  client: FeynmanClient | null = null;
  // Renamed from `manifest` to avoid shadowing Obsidian's `Plugin.manifest`
  // (which holds the plugin's own manifest.json, typed as PluginManifest).
  serverManifest: ManifestResponse | null = null;

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };

    // Register views first so commands that open them have somewhere to go.
    this.registerView(
      VIEW_TYPE_FEYNMAN_CHAT,
      (leaf: WorkspaceLeaf) => new FeynmanChatView(leaf),
    );
    this.registerView(
      VIEW_TYPE_FEYNMAN_ARTIFACTS,
      (leaf: WorkspaceLeaf) => new FeynmanArtifactView(leaf),
    );
    this.registerView(
      VIEW_TYPE_FEYNMAN_WORKFLOWS,
      (leaf: WorkspaceLeaf) =>
        new FeynmanWorkflowsView(leaf, () => this.getWorkflowsDeps()),
    );

    this.addSettingTab(new FeynmanSettingTab(this.app, this));

    // Ribbon icon — opens the workflows pane in the right sidebar.
    this.addRibbonIcon("atom", "Feynman: open workflows", () => {
      void this.openWorkflowsPane();
    });

    // Construct the transport client; resolves base URL by backend mode.
    this.client = new FeynmanClient({
      baseUrl: resolveBaseUrl(this.settings),
      getAuth: () => resolveAuth(this.settings),
    });

    // Try fetching the manifest. Tolerate failures silently — the workflows
    // pane shows a "not connected" state, and if the user hasn't onboarded
    // yet we pop settings open so they can configure a backend.
    let manifest: ManifestResponse | null = null;
    try {
      manifest = await this.client.manifest();
      this.serverManifest = manifest;
      if (!this.settings.onboardingCompleted) {
        // Server already reachable on first load — mark onboarding done.
        this.settings.onboardingCompleted = true;
        await this.saveSettings();
      }
    } catch {
      if (!this.settings.onboardingCompleted) {
        // First run, no server. Open settings on the next tick so the
        // workspace has finished laying out.
        window.setTimeout(() => this.openOnboarding(), 250);
      }
    }

    registerCommands(this, {
      client: this.client,
      manifest: manifest ?? {
        prompts: [],
        skills: [],
        models: [],
        capabilities: { vaultModes: [], fsBridge: false, artifactPull: false },
      },
      getVaultMode: () => backendToVaultMode(this.settings.backend),
      getModel: () =>
        this.settings.model.length > 0 ? this.settings.model : undefined,
    });

    // Diagnostic command — always available regardless of manifest fetch.
    this.addCommand({
      id: "feynman-server-status",
      name: "Feynman: Server status",
      callback: () => {
        void this.showStatus();
      },
    });
  }

  override onunload(): void {
    // Obsidian detaches our registered views automatically on unload.
    // Active SSE streams own AbortControllers and tear down in chat-view
    // onClose; no plugin-level cleanup needed beyond that.
  }

  /** Snapshot of the state the workflows pane needs to render + run. */
  getWorkflowsDeps(): WorkflowsViewDeps {
    const baseUrl = resolveBaseUrl(this.settings);
    return {
      client:
        this.client ??
        new FeynmanClient({
          baseUrl,
          getAuth: () => resolveAuth(this.settings),
        }),
      manifest: this.serverManifest,
      getVaultMode: () => backendToVaultMode(this.settings.backend),
      getModel: () =>
        this.settings.model.length > 0 ? this.settings.model : undefined,
      serverOk: this.serverManifest !== null,
      serverLabel: `${this.settings.backend} · ${baseUrl.replace(/^https?:\/\//, "")}`,
      openSettings: () => {
        const settingApi = (
          this.app as unknown as {
            setting?: {
              open?: () => void;
              openTabById?: (id: string) => void;
            };
          }
        ).setting;
        if (settingApi === undefined) return;
        settingApi.open?.();
        settingApi.openTabById?.(this.manifest.id);
      },
    };
  }

  /** Persist current settings to the plugin's data file. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Reconstruct the client (settings may have changed) and re-fetch
   * /v1/manifest. Returns `{ ok: true }` on success; `{ ok: false, error }`
   * on failure — surfaced by the onboarding / Test connection button.
   */
  async refreshConnection(): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = resolveBaseUrl(this.settings);
    this.client = new FeynmanClient({
      baseUrl,
      getAuth: () => resolveAuth(this.settings),
    });
    try {
      const manifest = await this.client.manifest();
      this.serverManifest = manifest;
      this.refreshWorkflowsPane();
      return { ok: true };
    } catch (err) {
      this.serverManifest = null;
      this.refreshWorkflowsPane();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Re-render the workflows pane if it's open. */
  refreshWorkflowsPane(): void {
    const leaves = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_FEYNMAN_WORKFLOWS,
    );
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof FeynmanWorkflowsView) view.rerender();
    }
  }

  /** Open the plugin's settings tab — used by the onboarding auto-open. */
  openOnboarding(): void {
    const settingApi = (
      this.app as unknown as {
        setting?: {
          open?: () => void;
          openTabById?: (id: string) => void;
        };
      }
    ).setting;
    if (settingApi === undefined) return;
    settingApi.open?.();
    settingApi.openTabById?.(this.manifest.id);
  }

  /** Reveal (or create) the workflows pane in the right sidebar. */
  async openWorkflowsPane(): Promise<void> {
    const workspace = this.app.workspace;
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
    if (leaf !== null) {
      workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof FeynmanWorkflowsView) view.rerender();
    }
  }

  /** Live health + manifest probe surfaced through a Notice (§8.1). */
  private async showStatus(): Promise<void> {
    if (this.client === null) {
      new Notice("Feynman: client not initialized");
      return;
    }
    try {
      const [health, manifest] = await Promise.all([
        this.client.health(),
        this.client.manifest(),
      ]);
      this.serverManifest = manifest;
      const promptCount = manifest.prompts.length;
      new Notice(
        `Feynman: ok=${String(health.ok)} version=${health.version} prompts=${promptCount}`,
      );
    } catch (err) {
      new Notice(
        `Feynman: status failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function resolveBaseUrl(settings: FeynmanSettings): string {
  switch (settings.backend) {
    case "docker": {
      const port = settings.docker.hostPort > 0 ? settings.docker.hostPort : 7777;
      return `http://127.0.0.1:${port}`;
    }
    case "self-hosted":
      return settings.selfHosted.baseUrl;
    case "modal":
      // §6.3 — Modal uses a fixed custom domain. The plugin assumes a
      // sensible default; settings can override via self-hosted mode if a
      // user is on a private deploy.
      return "https://api.feynman.is";
    default: {
      const exhaustive: never = settings.backend;
      return exhaustive;
    }
  }
}

function resolveAuth(settings: FeynmanSettings): string | null {
  switch (settings.backend) {
    case "docker":
      // The container's random bearer token is exposed by the supervisor;
      // until that lands we send no auth header. localhost-bound listener
      // is still defense-in-depth per §6.1.
      return null;
    case "self-hosted":
      return settings.selfHosted.bearerToken.length > 0
        ? settings.selfHosted.bearerToken
        : null;
    case "modal":
      return settings.modal.licenseKey.length > 0
        ? settings.modal.licenseKey
        : null;
    default: {
      const exhaustive: never = settings.backend;
      return exhaustive;
    }
  }
}

function backendToVaultMode(
  backend: FeynmanSettings["backend"],
): VaultMode {
  switch (backend) {
    case "docker":
      return "docker";
    case "self-hosted":
      // §6.2 — sandbox is v1 default; fs-bridge is M4+.
      return "sandbox";
    case "modal":
      // §6.3 — always FS-bridge.
      return "fs-bridge";
    default: {
      const exhaustive: never = backend;
      return exhaustive;
    }
  }
}
