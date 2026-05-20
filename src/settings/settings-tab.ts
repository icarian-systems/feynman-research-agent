// Settings tab. Sections enumerated in docs/ARCHITECTURE.md §8.4.
//
// First-run onboarding lives at the top of the tab. When the user hasn't yet
// picked a backend AND no server is reachable, the host plugin opens this
// tab automatically (see main.ts onload).

import { App, FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";
import type FeynmanPlugin from "../../main";
import { WaitlistModal } from "../views/waitlist-modal";
import {
  DockerSupervisor,
  defaultEnvFilePath,
  DEFAULT_CONTAINER_NAME,
  generateAuthToken,
  type DockerStatus,
} from "../docker/supervisor";
import type { DockerPrefs } from "../docker/prefs";

/**
 * Truncate user-facing error bodies to a hard cap so a server that returns a
 * 4 MB HTML response doesn't crash the Notice UI / leak structure. Used at
 * every `new Notice(error.message)` site in this file. The transport client
 * runs its own scrub-then-truncate before throwing; this is the second-layer
 * guard on the UI side.
 */
function truncate(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Validate a user-entered self-hosted base URL. Rules:
 *   - Must start with `http://` or `https://`.
 *   - `http://` is only permitted when the host is `127.0.0.1`, `localhost`,
 *     or `::1` (developer-loopback escape hatch). Any public hostname must
 *     use `https://` so the bearer token doesn't fly over plaintext.
 *
 * Returns `{ ok: true }` on accept, `{ ok: false, error }` on reject. The
 * caller paints `error` into an inline `.feynman-error` div and skips
 * `saveSettings()` so the persisted value stays valid.
 */
function validateSelfHostedUrl(
  raw: string,
): { ok: true } | { ok: false; error: string } {
  const v = raw.trim();
  if (v.length === 0) {
    // Empty is acceptable (user clearing the field); treat as ok so we
    // don't fight the user. Save still happens via the caller branch.
    return { ok: true };
  }
  if (!/^https?:\/\//i.test(v)) {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    const isLoopback =
      host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!isLoopback) {
      return {
        ok: false,
        error:
          "http:// only allowed for 127.0.0.1, localhost, or ::1; use https:// for public hosts",
      };
    }
  }
  return { ok: true };
}

const SAVE_DEBOUNCE_MS = 400;

/**
 * Validate a port number for the Docker host-port field. 0 is the
 * "auto-assign" sentinel; otherwise the value must sit inside the TCP range.
 */
function validatePort(n: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "Port must be an integer" };
  }
  if (n === 0) return { ok: true };
  if (n < 1 || n > 65535) {
    return { ok: false, error: "Port must be in [1, 65535] (or 0 for auto)" };
  }
  return { ok: true };
}

/**
 * Persisted plugin settings. Mirrors the §8.4 section layout. M2 fills in the
 * actual inputs; this interface declares the shape `loadData()/saveData()`
 * round-trips. Defaults live in `DEFAULT_SETTINGS` below.
 */
export interface FeynmanSettings {
  backend: "docker" | "self-hosted" | "modal";

  docker: {
    imageTag: string;
    hostPort: number;          // 0 = auto-assign per vault
    vaultMountPath: string;    // absolute host path; defaults to vault root
    /**
     * Random 32-byte hex bearer token generated on first Docker start by
     * Agent 4 (Security). Written into the container env-file as
     * `FEYNMAN_AUTH_TOKEN`; the plugin sends it on every request as
     * `Authorization: Bearer <token>`. Empty string means "not yet
     * generated"; the next `runDockerSetup` will populate it.
     */
    authToken: string;
    apiKeys: {
      anthropic?: string;
    };
  };

  /** Optional provider keys (Agent 6 / Wave 3). Plaintext on disk; same
   * disclosure pattern as the Anthropic key in the Docker section. */
  providerKeys: {
    openai?: string;
    exa?: string;
    perplexity?: string;
    gemini?: string;
  };

  selfHosted: {
    baseUrl: string;
    bearerToken: string;
  };

  modal: {
    licenseKey: string;
  };

  model: string;               // id from /v1/manifest.models[].id
  workspaceFolder: string;     // default "Feynman/"

  /** Flips to true after the user successfully tests a server connection. */
  onboardingCompleted: boolean;
  /**
   * Set on "I'll configure later" — separate from onboardingCompleted so a
   * half-set plugin doesn't masquerade as done. `null` when the user has not
   * actively skipped (initial state, or has since completed).
   */
  onboardingSkippedAt: number | null;

  /** Feature flags (Agent 6 / Wave 3). */
  features: {
    waitlist: {
      enabled: boolean;
    };
  };

  /**
   * Persisted in-flight runs. Keys are runIds; values carry the last SSE
   * framing id so we can resume with `Last-Event-ID` after a vault reload.
   * Stale entries (>24 h old or that return 404 on the server) are pruned by
   * main.ts on next load.
   */
  persistedRuns: Record<string, { lastEventId?: string; updatedAt: number }>;
}

export const DEFAULT_SETTINGS: FeynmanSettings = {
  backend: "docker",
  docker: {
    imageTag: "icariansystems/feynman",
    hostPort: 0,
    vaultMountPath: "",
    authToken: "",
    apiKeys: {},
  },
  providerKeys: {},
  selfHosted: { baseUrl: "", bearerToken: "" },
  modal: { licenseKey: "" },
  model: "",
  workspaceFolder: "Feynman/",
  onboardingCompleted: false,
  onboardingSkippedAt: null,
  features: { waitlist: { enabled: true } },
  persistedRuns: {},
};

/**
 * Resolve the vault root absolute path, when Obsidian exposes it. Only the
 * desktop `FileSystemAdapter` carries the base path; mobile adapters return
 * undefined and we fall back to a placeholder.
 */
function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return "";
}

export class FeynmanSettingTab extends PluginSettingTab {
  private readonly plugin: FeynmanPlugin;
  /**
   * Shared supervisor instance. The class is mostly stateless — it caches
   * the last-chosen port + container name so subsequent `status()` /
   * `stop()` calls on this tab session target the right container without
   * re-asking. One instance per tab is enough.
   */
  private readonly supervisor = new DockerSupervisor();
  /** Debounced save handle — see queueSave(). */
  private saveTimer: number | null = null;
  /** Container for the model-picker subtree so we can re-render in place. */
  private modelSection: HTMLElement | null = null;

  constructor(app: App, plugin: FeynmanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Trailing-edge debounced save. Every onChange handler routes saves through
   * here so a 60-char paste into the Anthropic key field doesn't fire 60
   * writes to data.json. Per-field validation runs synchronously in the
   * handler; only the persist step is deferred.
   */
  private queueSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, SAVE_DEBOUNCE_MS);
    // Track the handle through Obsidian's lifecycle so a tab dispose cancels
    // the timer if the user navigates away mid-debounce. Cast through unknown
    // because Obsidian's `registerInterval` ts signature wants number.
    this.plugin.registerInterval(this.saveTimer);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("feynman-settings");

    if (!this.plugin.settings.onboardingCompleted) {
      this.renderOnboarding(containerEl);
    }

    this.renderBackend(containerEl);
    this.renderDocker(containerEl);
    this.renderProviderKeys(containerEl);
    this.renderSelfHosted(containerEl);
    this.renderModalTier(containerEl);
    this.renderModelPicker(containerEl);
    this.renderWorkspace(containerEl);
  }

  /** Snapshot the current settings into a DockerPrefs the supervisor wants. */
  private buildDockerPrefs(): DockerPrefs {
    const d = this.plugin.settings.docker;
    const vaultRoot = getVaultBasePath(this.app);
    return {
      imageTag: d.imageTag.length > 0 ? d.imageTag : "icariansystems/feynman",
      hostPort: d.hostPort,
      containerName: DEFAULT_CONTAINER_NAME,
      vaultMountSrc: d.vaultMountPath.length > 0 ? d.vaultMountPath : vaultRoot,
      vaultMountDst: "/vault",
      // Read persisted token; runDockerSetup populates it on first start.
      authToken: d.authToken,
    };
  }

  /** Human-readable label for the container state pill. */
  private statusLabel(s: DockerStatus): string {
    switch (s) {
      case "running":
        return "Container: running";
      case "stopped":
        return "Container: stopped";
      case "not-installed":
        return "Container: Docker not installed";
      default: {
        const exhaustive: never = s;
        return exhaustive;
      }
    }
  }

  /** Refresh a previously-rendered state indicator span in-place. */
  private async refreshStatusIndicator(target: HTMLElement): Promise<void> {
    target.setText("Container: checking…");
    try {
      const s = await this.supervisor.status();
      target.setText(this.statusLabel(s));
      target.dataset.state = s;
    } catch (err) {
      target.setText(
        `Container: status failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  /**
   * Drive the full first-run path: check → pull → start. Updates the
   * passed-in button + status span as it goes. Surfaces every failure
   * mode through a Notice; never throws to the caller.
   */
  private async runDockerSetup(
    btn: HTMLButtonElement,
    statusEl: HTMLElement,
  ): Promise<void> {
    const originalText = btn.getText?.() ?? "Set up Docker";
    btn.setAttr("disabled", "true");
    statusEl.setText("Container: setting up…");
    try {
      const check = await this.supervisor.check();
      if (!check.ok) {
        const reason = check.reason ?? "unknown";
        const detail = check.detail ?? "";
        new Notice(
          `Feynman: Docker check failed (${reason})${detail.length > 0 ? ` — ${truncate(detail)}` : ""}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      const prefs = this.buildDockerPrefs();
      const envFilePath = defaultEnvFilePath();

      // First-start bearer-token generation. If no token is persisted, mint
      // one and save it before launching the container; the supervisor
      // writes it into the env-file so the server can match incoming
      // `Authorization: Bearer …` headers against `FEYNMAN_AUTH_TOKEN`.
      if (prefs.authToken.length === 0) {
        const token = generateAuthToken();
        prefs.authToken = token;
        this.plugin.settings.docker.authToken = token;
        await this.plugin.saveSettings();
      }

      statusEl.setText("Container: pulling image…");
      btn.setText("Pulling image…");
      try {
        await this.supervisor.pull(prefs.imageTag, (line) => {
          // Surface the trailing progress line on the status indicator.
          // `docker pull` lines are short enough to fit.
          statusEl.setText(`Pulling: ${line}`);
        });
      } catch (err) {
        new Notice(
          `Feynman: pull failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      statusEl.setText("Container: starting…");
      btn.setText("Starting…");
      try {
        // Populate the env-file with the Anthropic key + bearer token. The
        // supervisor writes it with chmod 600 on POSIX so other local users
        // can't read the key off disk; the `--env-file` flag keeps the
        // values off the process arglist (no `ps aux` leak, no `docker
        // inspect` env-array tail).
        const envVars: Record<string, string> = {
          FEYNMAN_AUTH_TOKEN: prefs.authToken,
        };
        const anthropicKey = this.plugin.settings.docker.apiKeys.anthropic;
        if (anthropicKey !== undefined && anthropicKey.length > 0) {
          envVars.ANTHROPIC_API_KEY = anthropicKey;
        }
        // Forward optional provider keys to the container — these are
        // off by default, set via the "Optional provider keys" section.
        const providerKeys = this.plugin.settings.providerKeys;
        if (providerKeys.openai !== undefined && providerKeys.openai.length > 0) {
          envVars.OPENAI_API_KEY = providerKeys.openai;
        }
        if (providerKeys.exa !== undefined && providerKeys.exa.length > 0) {
          envVars.EXA_API_KEY = providerKeys.exa;
        }
        if (providerKeys.perplexity !== undefined && providerKeys.perplexity.length > 0) {
          envVars.PERPLEXITY_API_KEY = providerKeys.perplexity;
        }
        if (providerKeys.gemini !== undefined && providerKeys.gemini.length > 0) {
          envVars.GEMINI_API_KEY = providerKeys.gemini;
        }
        const result = await this.supervisor.start(prefs, envFilePath, envVars);
        new Notice(
          `Feynman: server running on port ${String(result.port)}`,
        );
        // Settings haven't been told the chosen port (auto-bump may have
        // moved it); persist if the supervisor picked something else.
        if (
          this.plugin.settings.docker.hostPort !== result.port &&
          this.plugin.settings.docker.hostPort !== 0
        ) {
          this.plugin.settings.docker.hostPort = result.port;
          await this.plugin.saveSettings();
        }
      } catch (err) {
        new Notice(
          `Feynman: start failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      // Reconnect the plugin's transport client so the workflows pane
      // notices the new server.
      await this.plugin.refreshConnection();
      await this.refreshStatusIndicator(statusEl);
    } finally {
      btn.removeAttribute("disabled");
      btn.setText(originalText);
    }
  }

  // -------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------

  private renderOnboarding(host: HTMLElement): void {
    const wrap = host.createDiv({ cls: "feynman-onboarding" });

    wrap.createEl("h2", {
      text: "Welcome to Feynman",
      cls: "feynman-onboarding-title",
    });
    wrap.createEl("p", {
      cls: "feynman-onboarding-blurb",
      text: "Feynman runs research workflows from inside Obsidian. Pick how you'd like to host the agent runtime — you can change this later.",
    });

    // --- Option 1: Local Docker ---------------------------------------
    const dockerCard = wrap.createDiv({
      cls: "feynman-onboarding-card feynman-onboarding-card-active",
    });
    dockerCard.createDiv({
      cls: "feynman-onboarding-card-title",
      text: "Local Docker",
    });
    dockerCard.createDiv({
      cls: "feynman-onboarding-card-body",
      text: "Run a free Docker container on this machine. Bring your own API keys (Anthropic minimum). No subscription.",
    });
    // One-line disclosure pointing at README → Privacy for the full story.
    // Kept terse here so the onboarding card stays scannable; the in-field
    // disclosure under the Anthropic-key setting carries the full path.
    dockerCard
      .createDiv({ cls: "feynman-warning" })
      .setText(
        "Your Anthropic key is stored locally in plaintext at .obsidian/plugins/feynman/data.json. If you use Obsidian Sync with 'Sync plugin config' enabled, this file syncs to other devices.",
      );

    // State indicator above the Set-up button. Reflects supervisor.status();
    // refreshed on tab render and after every button click.
    const dockerStatusEl = dockerCard.createSpan({
      cls: "feynman-docker-state",
      text: "Container: checking…",
    });
    void this.refreshStatusIndicator(dockerStatusEl);

    const dockerActions = dockerCard.createDiv({
      cls: "feynman-onboarding-card-actions",
    });
    const dockerBtn = dockerActions.createEl("button", {
      cls: "mod-cta",
      text: "Set up Docker",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(dockerBtn, "click", () => {
      this.plugin.settings.backend = "docker";
      this.queueSave();
      void this.runDockerSetup(dockerBtn, dockerStatusEl);
    });

    const pullLatestBtn = dockerActions.createEl("button", {
      text: "Pull latest image",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(pullLatestBtn, "click", () => {
      void this.runPullLatest(pullLatestBtn, dockerStatusEl);
    });

    // --- Option 2: Feynman Cloud (waitlist) ---------------------------
    const cloudCard = wrap.createDiv({
      cls: "feynman-onboarding-card",
    });
    cloudCard.createDiv({
      cls: "feynman-onboarding-card-title",
      text: "Feynman Cloud",
    });
    cloudCard.createDiv({
      cls: "feynman-onboarding-card-body",
      text: "Managed compute, managed keys, no Docker. Monthly subscription. Join the waitlist to be notified when the hosted tier ships.",
    });
    // Only surface the waitlist button when the feature flag is on.
    if (this.plugin.settings.features.waitlist.enabled) {
      const cloudActions = cloudCard.createDiv({
        cls: "feynman-onboarding-card-actions",
      });
      const cloudBtn = cloudActions.createEl("button", {
        text: "Join the waitlist",
        attr: { type: "button" },
      });
      this.plugin.registerDomEvent(cloudBtn, "click", () => {
        new WaitlistModal(this.plugin.app).open();
      });
    }

    // --- Test connection / Skip ---------------------------------------
    const footer = wrap.createDiv({ cls: "feynman-onboarding-footer" });
    const testBtn = footer.createEl("button", {
      text: "Test connection",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(testBtn, "click", () => {
      void this.testConnection(testBtn);
    });

    const skipBtn = footer.createEl("button", {
      text: "I'll configure later",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(skipBtn, "click", () => {
      // Skip vs complete: record the skip timestamp separately from the
      // completion flag so a half-set plugin doesn't sit looking "done".
      this.plugin.settings.onboardingSkippedAt = Date.now();
      void this.plugin.saveSettings();
      this.plugin.refreshWorkflowsPane();
      // Re-render so the onboarding card collapses below the picker.
      this.display();
    });
  }

  private async testConnection(btn: HTMLButtonElement): Promise<void> {
    const original = btn.getText?.() ?? "Test connection";
    btn.setText("Testing…");
    btn.setAttr("disabled", "true");
    try {
      const result = await this.plugin.refreshConnection();
      if (result.ok) {
        // True completion — clear the skip timestamp.
        this.plugin.settings.onboardingCompleted = true;
        this.plugin.settings.onboardingSkippedAt = null;
        await this.plugin.saveSettings();
        new Notice("Feynman: connected.");
        this.plugin.refreshWorkflowsPane();
        this.refreshModelPickerSection();
        this.display();
      } else {
        new Notice(
          `Feynman: connection failed — ${truncate(result.error ?? "unknown")}`,
        );
        btn.removeAttribute("disabled");
        btn.setText(original);
      }
    } catch (err) {
      new Notice(
        `Feynman: connection failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
      );
      btn.removeAttribute("disabled");
      btn.setText(original);
    }
  }

  // -------------------------------------------------------------------
  // Settings sections
  // -------------------------------------------------------------------

  private renderBackend(host: HTMLElement): void {
    new Setting(host).setName("Backend").setHeading();
    new Setting(host)
      .setName("Mode")
      .setDesc("Where the Feynman server runs.")
      .addDropdown((dd) => {
        dd.addOption("docker", "Local Docker");
        dd.addOption("self-hosted", "Self-hosted");
        // Managed Modal tier is M5; option is rendered (so users know it's
        // coming) but disabled so they can't pick a backend the plugin
        // can't currently service.
        dd.addOption("modal", "Managed Modal (coming soon)");
        dd.setValue(this.plugin.settings.backend);
        dd.selectEl
          .querySelector('option[value="modal"]')
          ?.setAttribute("disabled", "true");
        dd.onChange((v) => {
          this.plugin.settings.backend = v as FeynmanSettings["backend"];
          this.queueSave();
          // Debounced refresh so the workflows-pane label updates without a
          // manual "Test connection". Wrapped in the same debounce window as
          // saveSettings so a fat-fingered toggle doesn't fire two probes.
          window.setTimeout(() => {
            void this.plugin.refreshConnection();
          }, SAVE_DEBOUNCE_MS);
        });
      });
  }

  private renderDocker(host: HTMLElement): void {
    const head = new Setting(host).setName("Local Docker").setHeading();
    head.settingEl.addClass("feynman-section-docker");

    new Setting(host)
      .setName("Image")
      .setDesc(
        "Docker image to run. Defaults to the official 'icariansystems/feynman' on Docker Hub. " +
          "Override with a local tag (e.g. 'feynman-server') to use an image you've built yourself — " +
          "the plugin checks for a local image first before trying to pull.",
      )
      .addText((t) =>
        t
          .setPlaceholder("icariansystems/feynman")
          .setValue(this.plugin.settings.docker.imageTag)
          .onChange((v) => {
            this.plugin.settings.docker.imageTag = v;
            this.queueSave();
          }),
      );

    const portSetting = new Setting(host)
      .setName("Host port")
      .setDesc("Loopback port the container binds. 0 = auto.");
    const portErrorEl = portSetting.descEl.createDiv({ cls: "feynman-error" });
    portErrorEl.style.display = "none";
    portSetting.addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(this.plugin.settings.docker.hostPort));
      t.onChange((v) => {
        const n = Number(v);
        const validation = validatePort(Number.isFinite(n) ? n : NaN);
        if (validation.ok) {
          portErrorEl.setText("");
          portErrorEl.style.display = "none";
          this.plugin.settings.docker.hostPort = Number.isFinite(n) ? n : 0;
          this.queueSave();
        } else {
          portErrorEl.setText(validation.error);
          portErrorEl.style.display = "block";
        }
      });
    });

    // Vault mount path — the absolute host path the supervisor bind-mounts
    // into /vault. Default placeholder shows the Obsidian vault root so the
    // user can leave it empty to mean "this vault".
    const vaultRoot = getVaultBasePath(this.app);
    new Setting(host)
      .setName("Vault mount path")
      .setDesc(
        "Absolute host path bind-mounted into the container. Leave empty to mount this vault.",
      )
      .addText((t) => {
        t.setPlaceholder(vaultRoot.length > 0 ? vaultRoot : "/absolute/path");
        t.setValue(this.plugin.settings.docker.vaultMountPath);
        t.onChange((v) => {
          this.plugin.settings.docker.vaultMountPath = v;
          this.queueSave();
        });
      });

    const anthropicSetting = new Setting(host)
      .setName("Anthropic API key")
      .setDesc("Required. Passed into the container as ANTHROPIC_API_KEY.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-…");
        t.setValue(this.plugin.settings.docker.apiKeys.anthropic ?? "");
        t.onChange((v) => {
          this.plugin.settings.docker.apiKeys.anthropic = v;
          this.queueSave();
        });
      });
    // Loud disclosure: keys land in plaintext on disk, and Obsidian Sync
    // will replicate the file across devices if "Sync plugin config" is on.
    // Users have to opt out at the Sync settings level — the plugin can't
    // unilaterally exclude itself from sync (no public API).
    anthropicSetting.descEl
      .createDiv({ cls: "feynman-warning" })
      .setText(
        "Stored locally in plaintext at <vault>/.obsidian/plugins/feynman/data.json. " +
          'If you use Obsidian Sync with "Sync plugin config" enabled, this will sync to other devices.',
      );

    // Container state indicator + setup controls. Always present so the
    // user can re-run setup or pull a newer image after onboarding.
    const dockerSetupRow = host.createDiv({ cls: "feynman-docker-setup" });
    const setupStatusEl = dockerSetupRow.createSpan({
      cls: "feynman-docker-state",
      text: "Container: checking…",
    });
    void this.refreshStatusIndicator(setupStatusEl);

    const setupActions = dockerSetupRow.createDiv({
      cls: "feynman-docker-setup-actions",
    });
    const setupBtn = setupActions.createEl("button", {
      cls: "mod-cta",
      text: "Set up Docker",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(setupBtn, "click", () => {
      void this.runDockerSetup(setupBtn, setupStatusEl);
    });

    const pullBtn = setupActions.createEl("button", {
      text: "Pull latest image",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(pullBtn, "click", () => {
      void this.runPullLatest(pullBtn, setupStatusEl);
    });

    new Setting(host)
      .setName("Test connection")
      .setDesc("Probe /v1/health and /v1/manifest at the configured backend.")
      .addButton((b) => {
        b.setButtonText("Test").onClick(async () => {
          await this.testConnection(b.buttonEl);
        });
      });
  }

  /**
   * Render the Optional provider keys section. Picks up Agent 4's TODO on
   * the Anthropic key field — each provider input gets the same
   * `.feynman-warning` disclosure under it.
   */
  private renderProviderKeys(host: HTMLElement): void {
    new Setting(host).setName("Optional provider keys").setHeading();
    const note = host.createDiv({ cls: "feynman-warning" });
    note.setText(
      "Optional. Passed into the container alongside ANTHROPIC_API_KEY. " +
        "Stored locally in plaintext in data.json — see the disclosure on the Anthropic key.",
    );

    const fields: {
      name: string;
      desc: string;
      key: keyof FeynmanSettings["providerKeys"];
      placeholder: string;
    }[] = [
      { name: "OpenAI API key", desc: "OPENAI_API_KEY", key: "openai", placeholder: "sk-…" },
      { name: "Exa API key", desc: "EXA_API_KEY", key: "exa", placeholder: "…" },
      { name: "Perplexity API key", desc: "PERPLEXITY_API_KEY", key: "perplexity", placeholder: "pplx-…" },
      { name: "Gemini API key", desc: "GEMINI_API_KEY", key: "gemini", placeholder: "…" },
    ];

    for (const f of fields) {
      const setting = new Setting(host)
        .setName(f.name)
        .setDesc(f.desc)
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder(f.placeholder);
          t.setValue(this.plugin.settings.providerKeys[f.key] ?? "");
          t.onChange((v) => {
            // Persist undefined for empty strings so JSON stays tidy.
            if (v.length === 0) {
              delete this.plugin.settings.providerKeys[f.key];
            } else {
              this.plugin.settings.providerKeys[f.key] = v;
            }
            this.queueSave();
          });
        });
      setting.descEl
        .createDiv({ cls: "feynman-warning" })
        .setText("Stored in plaintext in data.json — see the Anthropic key for full disclosure.");
    }
  }

  /**
   * Re-render only the model picker subtree. Called when the manifest
   * advances (refreshConnection succeeded) so the user gets the latest model
   * list without a full display() rebuild.
   */
  refreshModelPickerSection(): void {
    if (this.modelSection === null) return;
    this.modelSection.empty();
    this.renderModelPickerInto(this.modelSection);
  }

  private renderModelPicker(host: HTMLElement): void {
    new Setting(host).setName("Model").setHeading();
    const section = host.createDiv({ cls: "feynman-model-section" });
    this.modelSection = section;
    this.renderModelPickerInto(section);
  }

  private renderModelPickerInto(host: HTMLElement): void {
    const manifestResponse = this.plugin.serverManifest;
    const setting = new Setting(host)
      .setName("Active model")
      .setDesc("Picked up from /v1/manifest.models. Server picks the default when none is set.");
    setting.addDropdown((dd) => {
      if (manifestResponse === null || manifestResponse.models.length === 0) {
        // No manifest yet — show a single disabled "Loading…" placeholder so
        // the user knows the picker exists and why it's not yet useful.
        dd.addOption("", "Loading…");
        dd.setValue("");
        dd.selectEl.disabled = true;
        return;
      }
      dd.addOption("", "(server default)");
      for (const m of manifestResponse.models) {
        dd.addOption(m.id, `${m.label}${m.provider !== undefined ? ` · ${m.provider}` : ""}`);
      }
      dd.setValue(this.plugin.settings.model);
      dd.onChange((v) => {
        this.plugin.settings.model = v;
        this.queueSave();
      });
    });
  }

  /**
   * Re-pull the configured image. Shorter path than full setup — no
   * container start, just refresh the image. Notice + status indicator
   * carry progress.
   */
  private async runPullLatest(
    btn: HTMLButtonElement,
    statusEl: HTMLElement,
  ): Promise<void> {
    const originalText = btn.getText?.() ?? "Pull latest image";
    btn.setAttr("disabled", "true");
    btn.setText("Pulling…");
    const imageTag =
      this.plugin.settings.docker.imageTag.length > 0
        ? this.plugin.settings.docker.imageTag
        : "icariansystems/feynman";
    new Notice(`Feynman: pulling ${imageTag}…`);
    try {
      await this.supervisor.pullLatest(imageTag, (line) => {
        statusEl.setText(`Pulling: ${line}`);
      });
      new Notice(`Feynman: pulled ${imageTag}.`);
    } catch (err) {
      new Notice(
        `Feynman: pull failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
      );
    } finally {
      btn.removeAttribute("disabled");
      btn.setText(originalText);
      await this.refreshStatusIndicator(statusEl);
    }
  }

  private renderSelfHosted(host: HTMLElement): void {
    new Setting(host).setName("Self-hosted").setHeading();

    const urlSetting = new Setting(host)
      .setName("Base URL")
      .setDesc("e.g. https://feynman.your-domain.com");
    const urlErrorEl = urlSetting.descEl.createDiv({ cls: "feynman-error" });
    urlErrorEl.style.display = "none";
    urlSetting.addText((t) => {
      t.setValue(this.plugin.settings.selfHosted.baseUrl).onChange((v) => {
        const validation = validateSelfHostedUrl(v);
        if (validation.ok) {
          urlErrorEl.setText("");
          urlErrorEl.style.display = "none";
          this.plugin.settings.selfHosted.baseUrl = v;
          this.queueSave();
        } else {
          urlErrorEl.setText(validation.error);
          urlErrorEl.style.display = "block";
          // Do NOT save — keep persisted value clean.
        }
      });
    });

    new Setting(host)
      .setName("Bearer token")
      .setDesc("Optional. Required if FEYNMAN_AUTH_TOKEN is set on the server.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.selfHosted.bearerToken);
        t.onChange((v) => {
          this.plugin.settings.selfHosted.bearerToken = v;
          this.queueSave();
        });
      });
  }

  private renderModalTier(host: HTMLElement): void {
    new Setting(host).setName("Feynman Cloud (coming soon)").setHeading();

    if (this.plugin.settings.features.waitlist.enabled) {
      new Setting(host)
        .setName("Join the waitlist")
        .setDesc(
          "Managed compute, managed keys, no Docker. Sign up to be notified when the hosted tier (M5) ships.",
        )
        .addButton((b) =>
          b
            .setButtonText("Join waitlist")
            .setCta()
            .onClick(() => {
              new WaitlistModal(this.plugin.app).open();
            }),
        );
    }

    new Setting(host)
      .setName("License key")
      .setDesc("Available with the hosted tier (M5). Disabled until then.")
      .addText((t) => {
        t.inputEl.disabled = true;
        t.setPlaceholder("disabled");
      });
  }

  private renderWorkspace(host: HTMLElement): void {
    new Setting(host).setName("Workspace").setHeading();
    new Setting(host)
      .setName("Folder")
      .setDesc("Where artifacts land in the vault (default: Feynman/).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.workspaceFolder)
          .onChange((v) => {
            this.plugin.settings.workspaceFolder = v;
            this.queueSave();
          }),
      );
  }
}
