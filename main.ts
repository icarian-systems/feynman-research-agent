// Feynman Obsidian plugin entry point. See docs/ARCHITECTURE.md §4.2, §8.

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import type { ManifestResponse } from "./src/protocol";
import { MIN_SERVER_VERSION } from "./src/protocol";

import { FeynmanClient, type EventStream } from "./src/transport/client";
import { registerCommands } from "./src/commands/register";
import { DockerSupervisor } from "./src/docker/supervisor";
import { FeynmanSettingTab, DEFAULT_SETTINGS, type FeynmanSettings } from "./src/settings/settings-tab";
import { resolveBaseUrl, resolveAuth, backendToVaultMode, openPluginSettings } from "./src/settings/derive";
import { FeynmanChatView, VIEW_TYPE_FEYNMAN_CHAT } from "./src/views/chat-view";
import { FeynmanWorkflowsView, VIEW_TYPE_FEYNMAN_WORKFLOWS } from "./src/views/workflows-view";
import { getWorkflowsDeps } from "./src/views/workflows-view.deps";
import { compareVersions, drainActiveRuns, resumePersistedRuns, openWorkflowsPane, showStatus, LAST_EVENT_PERSIST_MS } from "./src/plugin/lifecycle";

const EMPTY_MANIFEST: ManifestResponse = {
  prompts: [],
  skills: [],
  models: [],
  capabilities: { vaultModes: [], fsBridge: false, artifactPull: false },
};

export default class FeynmanPlugin extends Plugin {
  settings: FeynmanSettings = DEFAULT_SETTINGS;
  client: FeynmanClient | null = null;
  // Renamed from `manifest` to avoid shadowing Obsidian's `Plugin.manifest`.
  serverManifest: ManifestResponse | null = null;
  serverVersionError: string | null = null;

  /** Shared Docker supervisor — settings tab + command palette point here. */
  readonly supervisor = new DockerSupervisor();

  /** Aborted on unload — pass `.signal` into async work to cancel it. */
  readonly abortController = new AbortController();
  /** Live SSE streams keyed by runId. Drained on `onunload`. */
  readonly activeRuns: Map<string, { stream: EventStream; cleanup: () => void }> =
    new Map();
  private readonly lastEventTimers: Map<string, number> = new Map();

  override async onload(): Promise<void> {
    // Deep-merge persisted data over defaults so users with older data.json
    // files don't lose nested defaults (e.g. docker.vaultMountPath added in
    // a later release) when the persisted blob is missing those keys.
    const persisted = (await this.loadData()) as Partial<FeynmanSettings> | null;
    this.settings = mergeSettings(DEFAULT_SETTINGS, persisted ?? {});

    this.registerView(VIEW_TYPE_FEYNMAN_CHAT, (leaf: WorkspaceLeaf) => new FeynmanChatView(leaf));
    this.registerView(VIEW_TYPE_FEYNMAN_WORKFLOWS, (leaf: WorkspaceLeaf) =>
      new FeynmanWorkflowsView(leaf, () => getWorkflowsDeps(this)));

    this.addSettingTab(new FeynmanSettingTab(this.app, this));
    this.addRibbonIcon("atom", "Open workflows", () => void this.openWorkflowsPane());

    this.client = new FeynmanClient({
      baseUrl: resolveBaseUrl(this.settings),
      getAuth: () => resolveAuth(this.settings),
      clientVersion: this.manifest.version,
    });

    const manifest = await this.initialProbe();
    registerCommands(this, this.buildCommandsDeps(manifest));
    this.addCommand({
      id: "feynman-server-status",
      name: "Server status",
      callback: () => void this.showStatus(),
    });
    void this.resumeRuns();
  }

  /**
   * Initial /v1/manifest + /v1/health probe. Tolerates failures silently —
   * a missing server is the first-run state. Returns the manifest on success.
   */
  private async initialProbe(): Promise<ManifestResponse | null> {
    if (this.client === null) return null;
    try {
      const manifest = await this.client.manifest();
      this.serverManifest = manifest;
      try {
        const health = await this.client.health();
        this.checkServerVersion(health.version);
      } catch {
        this.serverVersionError = null;
      }
      if (!this.settings.onboardingCompleted) {
        this.settings.onboardingCompleted = true;
        await this.saveSettings();
      }
      return manifest;
    } catch {
      if (!this.settings.onboardingCompleted && this.settings.onboardingSkippedAt === null) {
        this.registerInterval(window.setTimeout(() => this.openOnboarding(), 250));
      }
      return null;
    }
  }

  override async onunload(): Promise<void> {
    this.abortController.abort();
    this.client?.closeAllStreams();
    await drainActiveRuns(this.client, this.activeRuns);
    for (const t of this.lastEventTimers.values()) window.clearTimeout(t);
    this.lastEventTimers.clear();
  }

  registerActiveRun(runId: string, stream: EventStream, cleanup: () => void): void {
    this.activeRuns.set(runId, { stream, cleanup });
  }

  unregisterActiveRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  /** Persistence sink for Last-Event-ID advances. Per-runId trailing debounce
   * (1 s) so a chatty stream doesn't write to data.json on every event. */
  recordLastEventId(runId: string, eventId: string): void {
    const existing = this.lastEventTimers.get(runId);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.lastEventTimers.delete(runId);
      this.settings.persistedRuns[runId] = { lastEventId: eventId, updatedAt: Date.now() };
      void this.saveSettings();
    }, LAST_EVENT_PERSIST_MS);
    this.lastEventTimers.set(runId, timer);
    this.registerInterval(timer);
  }

  private async resumeRuns(): Promise<void> {
    if (this.client === null) return;
    const dirty = await resumePersistedRuns(
      this.app, this.client, this.settings.persistedRuns,
      (registry) => ({ ...this.buildRunDeps(), registry }), this,
    );
    if (dirty) await this.saveSettings();
  }

  /** Shared run-deps slice used by buildCommandsDeps + resumeRuns. */
  private buildRunDeps() {
    return {
      client: this.client as FeynmanClient,
      getVaultMode: () => backendToVaultMode(this.settings.backend),
      getModel: () => (this.settings.model.length > 0 ? this.settings.model : undefined),
      onLastEventIdAdvance: (id: string, ev: string) => this.recordLastEventId(id, ev),
    };
  }

  /** Persist current settings to the plugin's data file. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Build the deps object both `registerCommands` paths use. */
  private buildCommandsDeps(manifest: ManifestResponse | null) {
    return {
      ...this.buildRunDeps(),
      manifest: manifest ?? EMPTY_MANIFEST,
      registry: this,
      supervisor: this.supervisor,
    };
  }

  /** Reconstruct the client and re-fetch /v1/manifest. Re-registers commands
   * with the refreshed manifest so titles track server-side changes. */
  async refreshConnection(): Promise<{ ok: boolean; error?: string }> {
    this.client?.closeAllStreams();
    this.client = new FeynmanClient({
      baseUrl: resolveBaseUrl(this.settings),
      getAuth: () => resolveAuth(this.settings),
      clientVersion: this.manifest.version,
    });
    try {
      const [health, manifest] = await Promise.all([this.client.health(), this.client.manifest()]);
      this.serverManifest = manifest;
      this.checkServerVersion(health.version);
      this.refreshWorkflowsPane();
      registerCommands(this, this.buildCommandsDeps(manifest));
      return { ok: true };
    } catch (err) {
      this.serverManifest = null;
      this.serverVersionError = null;
      this.refreshWorkflowsPane();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private checkServerVersion(v: string): void {
    if (compareVersions(v, MIN_SERVER_VERSION) < 0) {
      const msg = `Server is v${v} but plugin expects ≥${MIN_SERVER_VERSION}; pull a newer image.`;
      this.serverVersionError = msg;
      new Notice(`Feynman: ${msg}`);
    } else {
      this.serverVersionError = null;
    }
  }

  refreshWorkflowsPane(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FEYNMAN_WORKFLOWS)) {
      const view = leaf.view;
      if (view instanceof FeynmanWorkflowsView) view.rerender();
    }
  }

  openOnboarding(): void {
    openPluginSettings(this.app, this.manifest.id);
  }

  openWorkflowsPane(): Promise<void> {
    return openWorkflowsPane(this.app.workspace);
  }

  private showStatus(): Promise<void> {
    return showStatus(
      this.client,
      (m) => { this.serverManifest = m; },
      (v) => this.checkServerVersion(v),
      () => this.refreshWorkflowsPane(),
    );
  }
}

/**
 * Deep-merge persisted settings over defaults. Only descends into plain
 * objects; arrays and primitives are taken from the persisted value when
 * present, otherwise from defaults. This protects against the
 * `docker.vaultMountPath = undefined` class of bugs where a newer code
 * path reads a field that an older data.json never persisted.
 */
function mergeSettings(
  defaults: FeynmanSettings,
  persisted: Partial<FeynmanSettings>,
): FeynmanSettings {
  return deepMerge(defaults, persisted) as FeynmanSettings;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, bv] of Object.entries(b)) {
    if (bv === undefined) continue;
    const av = a[k];
    if (isPlainObject(av) && isPlainObject(bv)) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}
