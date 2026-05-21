// Settings tab. Sections enumerated in docs/ARCHITECTURE.md §8.4.
//
// First-run onboarding lives at the top of the tab. When the user hasn't yet
// picked a backend AND no server is reachable, the host plugin opens this
// tab automatically (see main.ts onload).

import { App, FileSystemAdapter, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import { platform } from "node:os";
import { join as pathJoin } from "node:path";
import type FeynmanPlugin from "../../main";
import { WaitlistModal } from "../views/waitlist-modal";
import { OAuthLoginModal } from "../views/oauth-login-modal";
import {
  AuthClient,
  type ConfiguredProvider,
  type OAuthProviderInfo,
} from "../transport/auth-client";
import { resolveBaseUrl as resolveBaseUrlForPlugin, resolveAuth } from "./derive";
import {
  DockerSupervisor,
  defaultEnvFilePath,
  DEFAULT_CONTAINER_NAME,
  generateAuthToken,
  type DockerCheckReason,
  type DockerStatus,
} from "../docker/supervisor";
import type { DockerPrefs } from "../docker/prefs";

/**
 * Map a docker check failure to OS-specific, actionable copy. The caller
 * already truncates the underlying detail; this helper produces the
 * top-line guidance the user actually needs to fix the problem.
 */
export function dockerErrorMessage(
  reason: DockerCheckReason,
  plat: NodeJS.Platform = platform(),
): string {
  switch (reason) {
    case "not-installed":
      if (plat === "darwin") {
        return "Docker Desktop not found. Install from docker.com, then quit and relaunch Obsidian (a GUI-launched app has a limited PATH).";
      }
      if (plat === "win32") {
        return "Docker Desktop not found. Install from docker.com and reboot (or sign out and back in) to refresh the system PATH.";
      }
      return "Docker CLI not found. Install via your package manager (e.g. 'apt install docker.io').";
    case "daemon-down":
      if (plat === "darwin") {
        return "Docker Desktop is not running. Start it from Applications and try again.";
      }
      if (plat === "win32") {
        return "Docker Desktop is not running. Start it from the Start menu and wait for the whale icon to settle.";
      }
      return "Docker daemon not running. Try 'sudo systemctl start docker'.";
    case "permission-denied":
      return "Permission denied on the Docker socket. Run 'sudo usermod -aG docker $USER', then log out and back in.";
    case "sandboxed":
      return "Sandboxed Obsidian (Flatpak/Snap) cannot reach the Docker socket. Install the native .deb or .AppImage instead.";
  }
}

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
  /**
   * Auto-open behavior for documents the agent creates (via `artifact.written`).
   *   - "off"  : never auto-open; the chat-view callout's clickable links are
   *              the only entry point.
   *   - "last" : when the run finishes, open the last artifact written. Most
   *              workflows write supporting files first and the summary doc
   *              last, so this surfaces the user's likely target.
   *   - "all"  : open every artifact in its own pane on run.done.
   * Default: "last".
   */
  autoOpenArtifacts: "off" | "last" | "all";
  /**
   * Whether to auto-accept agent-driven prompts (`tool.approval_required`
   * and `agent.question`). The plugin has no persistent chat interface for
   * back-and-forth, so by default we say "yes" and let the agent proceed.
   * Disable to surface the existing modal/form for each prompt.
   */
  autoApproveAgentPrompts: boolean;

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
    // Pinned to an immutable tag. Pulls from this exact image; a registry
    // compromise of `:latest` cannot downgrade existing users. Bump on each
    // release in lockstep with the server image build.
    imageTag: "icariansystems/feynman:1.0.0",
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
  autoOpenArtifacts: "last",
  autoApproveAgentPrompts: true,
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
   * Shared supervisor instance. Owned by the plugin so the command-palette
   * "Diagnose Docker" command and this settings tab agree on cached state
   * (resolved binary path, last container name).
   */
  private readonly supervisor: DockerSupervisor;
  /** Debounced save handle — see queueSave(). */
  private saveTimer: number | null = null;
  /** Container for the model-picker subtree so we can re-render in place. */
  private modelSection: HTMLElement | null = null;
  /**
   * Whether a container-affecting setting (API keys, image, port, mount) has
   * changed since the container was started. Drives the "Restart to apply"
   * banner.
   */
  private pendingRestart = false;
  /** Cached from the last status probe; gates whether to show the banner. */
  private lastKnownContainerRunning = false;
  /** The "Restart to apply" banner element; null before renderDocker runs. */
  private pendingRestartBanner: HTMLElement | null = null;

  constructor(app: App, plugin: FeynmanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.supervisor = plugin.supervisor;
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

    // Feynman Cloud / waitlist surfaces at the top — gated behind the
    // waitlist feature flag (default on). Drawing attention before the
    // Docker config gives early users a clear path to the hosted tier.
    this.renderModalTier(containerEl);
    this.renderBackend(containerEl);
    this.renderDocker(containerEl);
    this.renderProviderKeys(containerEl);
    this.renderSelfHosted(containerEl);
    this.renderModelPicker(containerEl);
    this.renderWorkspace(containerEl);
  }

  /** Snapshot the current settings into a DockerPrefs the supervisor wants. */
  private buildDockerPrefs(): DockerPrefs {
    const d = this.plugin.settings.docker;
    const vaultRoot = getVaultBasePath(this.app);
    // Defensive reads — a stale data.json from an older release may have
    // a partial `docker` object missing fields added later. Treat any
    // missing/non-string value as the empty string so the `.length > 0`
    // checks below fall through to the default.
    const imageTag = typeof d.imageTag === "string" ? d.imageTag : "";
    const vaultMountPath =
      typeof d.vaultMountPath === "string" ? d.vaultMountPath : "";
    const authToken = typeof d.authToken === "string" ? d.authToken : "";
    const hostPort = typeof d.hostPort === "number" ? d.hostPort : 0;
    // Default mount: <vault>/<workspaceFolder>, exposed at the same nested
    // path inside the container so vault-relative paths still resolve
    // (e.g. "Feynman/notes/x.md" → /vault/Feynman/notes/x.md). This scopes
    // the container's direct filesystem view to the workspace; everything
    // outside (other notes, .obsidian/, other plugins' data) is invisible
    // through the bind mount. The FS bridge still serves cross-vault reads
    // through its own validation + approval gates.
    const ws = (this.plugin.settings.workspaceFolder || "Feynman/").replace(/\/+$/, "");
    const customMount = vaultMountPath.length > 0;
    const scopedSrc =
      vaultRoot.length > 0 && ws.length > 0 ? pathJoin(vaultRoot, ws) : vaultRoot;
    return {
      imageTag: imageTag.length > 0 ? imageTag : "icariansystems/feynman:1.0.0",
      hostPort,
      containerName: DEFAULT_CONTAINER_NAME,
      vaultMountSrc: customMount ? vaultMountPath : scopedSrc,
      // Custom mounts land at /vault (whole-vault override); the scoped
      // default lands at /vault/<workspaceFolder> so the server still sees
      // vault-relative paths.
      vaultMountDst: customMount ? "/vault" : (ws.length > 0 ? `/vault/${ws}` : "/vault"),
      authToken,
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
    new Notice("Feynman: setting up Docker…");
    console.log("[feynman] runDockerSetup: start");
    try {
      console.log("[feynman] runDockerSetup: check()");
      const check = await this.supervisor.check();
      console.log("[feynman] runDockerSetup: check result", check);
      if (!check.ok && check.reason !== undefined) {
        const guidance = dockerErrorMessage(check.reason);
        const detail = check.detail ?? "";
        new Notice(
          `Feynman: ${guidance}${detail.length > 0 ? ` (${truncate(detail)})` : ""}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      const prefs = this.buildDockerPrefs();
      const envFilePath = defaultEnvFilePath();
      console.log("[feynman] runDockerSetup: prefs", {
        imageTag: prefs.imageTag,
        hostPort: prefs.hostPort,
        containerName: prefs.containerName,
        vaultMountSrc: prefs.vaultMountSrc,
        envFilePath,
        hasAuthToken: prefs.authToken.length > 0,
      });

      if (prefs.authToken.length === 0) {
        const token = generateAuthToken();
        prefs.authToken = token;
        this.plugin.settings.docker.authToken = token;
        await this.plugin.saveSettings();
        console.log("[feynman] runDockerSetup: minted new auth token");
      }

      statusEl.setText("Container: pulling image…");
      btn.setText("Pulling image…");
      new Notice(`Feynman: resolving image '${prefs.imageTag}'…`);
      try {
        console.log("[feynman] runDockerSetup: pull()", prefs.imageTag);
        await this.supervisor.pull(prefs.imageTag, (line) => {
          statusEl.setText(`Pulling: ${line}`);
          console.log("[feynman] pull progress:", line);
        });
        console.log("[feynman] runDockerSetup: pull() done");
      } catch (err) {
        console.error("[feynman] runDockerSetup: pull() failed", err);
        new Notice(
          `Feynman: pull failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      statusEl.setText("Container: starting…");
      btn.setText("Starting…");
      new Notice("Feynman: starting container…");
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
        console.log("[feynman] runDockerSetup: start()", {
          envKeys: Object.keys(envVars),
        });
        const result = await this.supervisor.start(prefs, envFilePath, envVars);
        console.log("[feynman] runDockerSetup: start() done", result);
        new Notice(
          `Feynman: server running (container ${result.containerName} on port ${String(result.port)})`,
        );
        if (
          this.plugin.settings.docker.hostPort !== result.port &&
          this.plugin.settings.docker.hostPort !== 0
        ) {
          this.plugin.settings.docker.hostPort = result.port;
          await this.plugin.saveSettings();
        }
      } catch (err) {
        console.error("[feynman] runDockerSetup: start() failed", err);
        new Notice(
          `Feynman: start failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
        );
        await this.refreshStatusIndicator(statusEl);
        return;
      }

      // `docker run -d` returns as soon as the container is *created*,
      // not when the Node process inside it has finished booting and bound
      // the port. Without a wait, the immediate refreshConnection() probe
      // races the server's startup and reports ERR_EMPTY_RESPONSE. Poll
      // /v1/health with a short per-attempt timeout until either it
      // responds or we give up after ~30s.
      statusEl.setText("Container: waiting for server…");
      btn.setText("Waiting…");
      const ready = await this.waitForServerReady(30_000);
      if (!ready) {
        new Notice(
          "Feynman: container started but server didn't respond within 30s. Check 'docker logs feynman-server' for the cause.",
        );
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

  /**
   * Poll the configured backend URL's /v1/health until it responds or the
   * budget expires. Uses Obsidian's `requestUrl` helper which runs in the
   * main process and bypasses the renderer's CORS enforcement — `fetch()`
   * from the renderer is blocked because the loopback server doesn't
   * return Access-Control-Allow-Origin headers. Auth status doesn't matter
   * here — even a 401 confirms the server is up.
   */
  private async waitForServerReady(budgetMs: number): Promise<boolean> {
    const url = `${resolveBaseUrlForPlugin(this.plugin.settings)}/v1/health`;
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        const res = await requestUrl({ url, method: "GET", throw: false });
        if (res.status > 0) {
          console.log(`[feynman] waitForServerReady: ready after ${attempt} probes (${res.status})`);
          return true;
        }
      } catch {
        // Connect refused / empty response — keep polling.
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    console.warn(`[feynman] waitForServerReady: gave up after ${attempt} probes`);
    return false;
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
        "Your Anthropic key is stored locally in plaintext at ~/.feynman/secrets.json (mode 0600, outside the vault — not synced by Obsidian Sync).",
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

    // ----- "Restart to apply" banner (hidden unless settings are dirty AND
    // the container is running) -----
    this.pendingRestartBanner = host.createDiv({ cls: "feynman-restart-banner" });
    this.renderPendingRestartBannerContent(this.pendingRestartBanner);
    this.updatePendingRestartBannerVisibility();

    // ----- Container status panel (re-renders based on current state) -----
    const statusPanel = host.createDiv({ cls: "feynman-docker-status-panel" });
    void this.renderDockerStatusPanel(statusPanel);

    // ----- Configuration subsection -----
    new Setting(host).setName("Configuration").setHeading();

    new Setting(host)
      .setName("Image")
      .setDesc(
        "Docker image to run. Defaults to the official pinned 'icariansystems/feynman:1.0.0' on Docker Hub. " +
          "Override with a local tag (e.g. 'feynman-server') to use an image you've built yourself — " +
          "the plugin checks for a local image first before trying to pull.",
      )
      .addText((t) =>
        t
          .setPlaceholder("icariansystems/feynman:1.0.0")
          .setValue(this.plugin.settings.docker.imageTag)
          .onChange((v) => {
            this.plugin.settings.docker.imageTag = v;
            this.queueSave();
            this.notePendingRestart();
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
          this.notePendingRestart();
        } else {
          portErrorEl.setText(validation.error);
          portErrorEl.style.display = "block";
        }
      });
    });

    const vaultRoot = getVaultBasePath(this.app);
    const wsForPlaceholder = (this.plugin.settings.workspaceFolder || "Feynman/").replace(/\/+$/, "");
    const defaultMountForPlaceholder =
      vaultRoot.length > 0 && wsForPlaceholder.length > 0
        ? `${vaultRoot}/${wsForPlaceholder}`
        : vaultRoot;
    new Setting(host)
      .setName("Vault mount path")
      .setDesc(
        "Absolute host path bind-mounted into the container. Leave empty to mount only the workspace folder (recommended) — the container's filesystem view is then scoped to that subfolder; the agent cannot see .obsidian/, other notes, or other plugins' data via direct fs access. Override with a wider path (e.g. the full vault root) only if you need the agent to bind-mount more than the workspace.",
      )
      .addText((t) => {
        t.setPlaceholder(defaultMountForPlaceholder.length > 0 ? defaultMountForPlaceholder : "/absolute/path");
        t.setValue(this.plugin.settings.docker.vaultMountPath);
        t.onChange((v) => {
          this.plugin.settings.docker.vaultMountPath = v;
          this.queueSave();
          this.notePendingRestart();
        });
      });

    // ----- Authentication subsection -----
    new Setting(host).setName("Authentication").setHeading();

    // OAuth sign-in lives above the API key fields — for users on Claude Pro,
    // ChatGPT Plus, etc. an OAuth login is the preferred path (no key copying).
    // API keys remain available below for users without a subscription.
    this.renderOAuthSection(host);
    this.renderAlphaSection(host);

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
          this.notePendingRestart();
        });
      });
    anthropicSetting.descEl
      .createDiv({ cls: "feynman-warning" })
      .setText(
        "Stored in plaintext at ~/.feynman/secrets.json (mode 0600). This file lives outside the vault so it is not synced by Obsidian Sync and is not visible to the agent process inside the Docker container.",
      );

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
   * Render the container status card + context-sensitive action buttons.
   * Re-rendered in place after setup/stop/pull so the UI tracks state.
   */
  private async renderDockerStatusPanel(panel: HTMLElement): Promise<void> {
    panel.empty();

    // Loading shimmer while we probe.
    const loading = panel.createDiv({ cls: "feynman-docker-status-card" });
    const loadingPill = loading.createSpan({
      cls: "feynman-docker-pill feynman-docker-pill-checking",
    });
    loadingPill.createSpan({ cls: "feynman-docker-pill-dot" });
    loadingPill.createSpan({ text: "Checking container status…" });

    let status: DockerStatus;
    try {
      status = await this.supervisor.status();
    } catch {
      status = "not-installed";
    }
    this.lastKnownContainerRunning = status === "running";
    this.updatePendingRestartBannerVisibility();

    panel.empty();

    const card = panel.createDiv({ cls: "feynman-docker-status-card" });
    const header = card.createDiv({ cls: "feynman-docker-status-header" });

    // Status pill.
    const pill = header.createSpan({
      cls: `feynman-docker-pill feynman-docker-pill-${status}`,
    });
    pill.createSpan({ cls: "feynman-docker-pill-dot" });
    pill.createSpan({ text: this.statusLabel(status) });

    // Detail line (image + port) when running. Useful so users see at a
    // glance which image is loaded and where it's reachable.
    if (status === "running") {
      const detail = header.createDiv({ cls: "feynman-docker-status-detail" });
      const imageTag =
        this.plugin.settings.docker.imageTag.length > 0
          ? this.plugin.settings.docker.imageTag
          : "icariansystems/feynman:1.0.0";
      const hostPort =
        this.plugin.settings.docker.hostPort > 0
          ? this.plugin.settings.docker.hostPort
          : 7777;
      detail.setText(`${imageTag} • http://127.0.0.1:${String(hostPort)}`);
    }

    // Action buttons. Context-sensitive: running → Stop/Restart, otherwise
    // Set up / Diagnose. Pull and Diagnose stay available across states.
    const actions = card.createDiv({ cls: "feynman-docker-status-actions" });

    if (status === "running") {
      const stopBtn = actions.createEl("button", {
        cls: "mod-warning",
        text: "Stop container",
        attr: { type: "button" },
      });
      this.plugin.registerDomEvent(stopBtn, "click", () => {
        void this.runDockerStop(stopBtn, panel);
      });

      const restartBtn = actions.createEl("button", {
        text: "Restart",
        attr: { type: "button" },
      });
      this.plugin.registerDomEvent(restartBtn, "click", () => {
        void this.runDockerRestart(restartBtn, panel);
      });
    } else if (status === "stopped") {
      const startBtn = actions.createEl("button", {
        cls: "mod-cta",
        text: "Start container",
        attr: { type: "button" },
      });
      this.plugin.registerDomEvent(startBtn, "click", () => {
        void this.runDockerSetupAndRefresh(startBtn, panel);
      });
    } else {
      // not-installed
      const setupBtn = actions.createEl("button", {
        cls: "mod-cta",
        text: "Set up Docker",
        attr: { type: "button" },
      });
      this.plugin.registerDomEvent(setupBtn, "click", () => {
        void this.runDockerSetupAndRefresh(setupBtn, panel);
      });
    }

    const pullBtn = actions.createEl("button", {
      text: "Pull latest image",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(pullBtn, "click", () => {
      void this.runPullLatestAndRefresh(pullBtn, panel);
    });
  }

  /** Run setup, then re-render the status panel so the UI catches up. */
  private async runDockerSetupAndRefresh(
    btn: HTMLButtonElement,
    panel: HTMLElement,
  ): Promise<void> {
    const inlineStatus = panel.querySelector(".feynman-docker-pill") as HTMLElement | null;
    const target =
      inlineStatus ?? panel.createSpan({ cls: "feynman-docker-state" });
    await this.runDockerSetup(btn, target);
    await this.renderDockerStatusPanel(panel);
    this.clearPendingRestart();
  }

  /**
   * Mark container-affecting settings as dirty. Called from every onChange
   * handler whose value lands in the container's env or `docker run` args.
   * Shows the "Restart to apply" banner if the container is currently up.
   */
  private notePendingRestart(): void {
    if (this.pendingRestart) return;
    this.pendingRestart = true;
    this.updatePendingRestartBannerVisibility();
  }

  /** Clear the dirty flag and hide the banner. Called after a successful
   *  setup/restart so the user knows the running container is in sync. */
  private clearPendingRestart(): void {
    this.pendingRestart = false;
    this.updatePendingRestartBannerVisibility();
  }

  /** Show the banner iff settings are dirty AND a container is running. */
  private updatePendingRestartBannerVisibility(): void {
    if (this.pendingRestartBanner === null) return;
    const show = this.pendingRestart && this.lastKnownContainerRunning;
    this.pendingRestartBanner.style.display = show ? "" : "none";
  }

  /** Build the static banner content. The element itself is shown/hidden
   *  by `updatePendingRestartBannerVisibility`. */
  private renderPendingRestartBannerContent(host: HTMLElement): void {
    host.empty();
    const inner = host.createDiv({ cls: "feynman-restart-banner-inner" });
    inner.createSpan({
      cls: "feynman-restart-banner-text",
      text: "Settings changed — restart the container to apply.",
    });
    const restartBtn = inner.createEl("button", {
      text: "Restart now",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.plugin.registerDomEvent(restartBtn, "click", () => {
      const panel = this.containerEl.querySelector(
        ".feynman-docker-status-panel",
      ) as HTMLElement | null;
      if (panel === null) return;
      void this.runDockerRestart(restartBtn, panel);
    });
  }

  private async runPullLatestAndRefresh(
    btn: HTMLButtonElement,
    panel: HTMLElement,
  ): Promise<void> {
    const inlineStatus = panel.querySelector(".feynman-docker-pill") as HTMLElement | null;
    const target =
      inlineStatus ?? panel.createSpan({ cls: "feynman-docker-state" });
    await this.runPullLatest(btn, target);
    await this.renderDockerStatusPanel(panel);
  }

  /** Stop the running container, then re-render the status panel. */
  private async runDockerStop(
    btn: HTMLButtonElement,
    panel: HTMLElement,
  ): Promise<void> {
    const originalText = btn.getText?.() ?? "Stop container";
    btn.setAttr("disabled", "true");
    btn.setText("Stopping…");
    new Notice("Feynman: stopping container…");
    try {
      await this.supervisor.stop();
      new Notice("Feynman: container stopped.");
    } catch (err) {
      console.error("[feynman] runDockerStop failed", err);
      new Notice(
        `Feynman: stop failed — ${truncate(err instanceof Error ? err.message : String(err))}`,
      );
    } finally {
      btn.removeAttribute("disabled");
      btn.setText(originalText);
      await this.renderDockerStatusPanel(panel);
    }
  }

  /** Stop → setup. Used by the Restart button when the container is up. */
  private async runDockerRestart(
    btn: HTMLButtonElement,
    panel: HTMLElement,
  ): Promise<void> {
    const originalText = btn.getText?.() ?? "Restart";
    btn.setAttr("disabled", "true");
    btn.setText("Restarting…");
    try {
      await this.supervisor.stop();
    } catch (err) {
      console.warn("[feynman] runDockerRestart: stop failed (continuing)", err);
    }
    // Reuse the setup path for the start half — it handles env-file,
    // port probe, image resolution, and the post-start health wait.
    const target = panel.createSpan({ cls: "feynman-docker-state" });
    target.style.display = "none"; // hidden — surface progress via Notices
    await this.runDockerSetup(btn, target);
    btn.removeAttribute("disabled");
    btn.setText(originalText);
    await this.renderDockerStatusPanel(panel);
    this.clearPendingRestart();
  }

  /**
   * Render the "Sign in with provider" section above the API key inputs.
   * The list is fetched lazily from `/v1/auth/providers` once the container
   * is reachable; if the server can't be reached we show a one-line message
   * with a Retry button. Configured/signed-in state is queried from
   * `/v1/auth/configured` and refreshed after each successful sign-in.
   */
  private renderOAuthSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: "feynman-oauth-section" });
    const headerSetting = new Setting(section)
      .setName("Sign in with provider")
      .setDesc(
        "Use a subscription you already have (Claude Pro, ChatGPT Plus, GitHub Copilot, etc.) instead of pasting an API key. Requires the container to be running.",
      );
    headerSetting.descEl.addClass("feynman-oauth-desc");

    const list = section.createDiv({ cls: "feynman-oauth-list" });
    const statusLine = section.createDiv({ cls: "feynman-oauth-status-line" });

    const renderLoading = (msg: string): void => {
      list.empty();
      statusLine.setText(msg);
    };

    const renderError = (err: string): void => {
      list.empty();
      statusLine.empty();
      const wrap = statusLine.createDiv({ cls: "feynman-warning" });
      wrap.createSpan({ text: err });
      const retry = wrap.createEl("button", {
        text: "Retry",
        attr: { type: "button" },
        cls: "feynman-oauth-retry",
      });
      this.plugin.registerDomEvent(retry, "click", () => {
        void load();
      });
    };

    const renderList = (
      providers: OAuthProviderInfo[],
      configured: Set<string>,
    ): void => {
      list.empty();
      statusLine.empty();
      if (providers.length === 0) {
        statusLine.setText("No OAuth providers registered on the server.");
        return;
      }
      for (const provider of providers) {
        const row = list.createDiv({ cls: "feynman-oauth-row" });
        const labelBox = row.createDiv({ cls: "feynman-oauth-row-label" });
        labelBox.createDiv({
          cls: "feynman-oauth-row-name",
          text: provider.name,
        });
        const isSignedIn = configured.has(provider.id);
        labelBox.createDiv({
          cls: isSignedIn
            ? "feynman-oauth-row-state feynman-oauth-signed-in"
            : "feynman-oauth-row-state",
          text: isSignedIn ? "Signed in" : "Not signed in",
        });

        const actions = row.createDiv({ cls: "feynman-oauth-row-actions" });
        const primary = actions.createEl("button", {
          text: isSignedIn ? "Re-sign in" : "Sign in",
          attr: { type: "button" },
          cls: isSignedIn ? "" : "mod-cta",
        });
        this.plugin.registerDomEvent(primary, "click", () => {
          this.openOAuthModal(provider);
        });
        if (isSignedIn) {
          const out = actions.createEl("button", {
            text: "Sign out",
            attr: { type: "button" },
          });
          this.plugin.registerDomEvent(out, "click", () => {
            void this.signOutProvider(provider.id);
          });
        }
      }
    };

    const load = async (): Promise<void> => {
      renderLoading("Loading providers…");
      const client = this.makeAuthClient();
      if (client === null) {
        renderError(
          "OAuth requires the local Docker backend with a connected container.",
        );
        return;
      }
      try {
        const [providers, configured] = await Promise.all([
          client.listProviders(),
          client.listConfigured(),
        ]);
        const configuredIds = new Set(configured.map((c) => c.id));
        renderList(providers, configuredIds);
      } catch (err) {
        renderError(
          `Could not reach the server — ${truncate(err instanceof Error ? err.message : String(err), 120)}`,
        );
      }
    };

    // Stash the loader on the section so the modal's onComplete can refresh
    // sign-in status without rebuilding the entire settings tree.
    (section as unknown as { feynmanReload?: () => Promise<void> }).feynmanReload =
      load;

    void load();
  }

  /** Build an AuthClient for the OAuth section. Returns null when the backend
   * isn't Docker (the OAuth endpoints only exist on the local server) or
   * when no bearer is set yet. */
  private makeAuthClient(): AuthClient | null {
    if (this.plugin.settings.backend !== "docker" && this.plugin.settings.backend !== "self-hosted") {
      return null;
    }
    const baseUrl = resolveBaseUrlForPlugin(this.plugin.settings);
    return new AuthClient({
      baseUrl,
      getAuth: () => resolveAuth(this.plugin.settings),
      clientVersion: this.plugin.manifest.version,
    });
  }

  private openOAuthModal(provider: OAuthProviderInfo): void {
    const client = this.makeAuthClient();
    if (client === null) {
      new Notice("OAuth requires the local Docker backend.");
      return;
    }
    const modal = new OAuthLoginModal(this.app, {
      providerId: provider.id,
      providerName: provider.name,
      client,
      onComplete: () => {
        // After a successful login the configured list changes — reload the
        // section in place.
        const section = this.containerEl.querySelector(
          ".feynman-oauth-section",
        ) as (HTMLElement & { feynmanReload?: () => Promise<void> }) | null;
        void section?.feynmanReload?.();
        // The container's env-file doesn't carry OAuth tokens (those live in
        // auth.json inside the container), so no restart is needed. But the
        // server only re-reads auth.json on cold start of each model
        // request — so we don't need to nudge the user. Suppress the
        // pending-restart banner for OAuth changes.
      },
    });
    modal.open();
  }

  private async signOutProvider(providerId: string): Promise<void> {
    const client = this.makeAuthClient();
    if (client === null) return;
    try {
      await client.logout(providerId);
      new Notice(`Signed out of ${providerId}.`);
      const section = this.containerEl.querySelector(
        ".feynman-oauth-section",
      ) as (HTMLElement & { feynmanReload?: () => Promise<void> }) | null;
      void section?.feynmanReload?.();
    } catch (err) {
      new Notice(
        `Sign-out failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Render the alphaXiv sign-in section. Separate from the model OAuth list
   * because alphaXiv has its own IdP (clerk.alphaxiv.org), its own auth.json
   * (~/.ahub/auth.json), and its tools (/lit search, paper fetch) only work
   * once the user is signed in.
   */
  private renderAlphaSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: "feynman-oauth-section feynman-alpha-section" });
    const header = new Setting(section)
      .setName("alphaXiv")
      .setDesc(
        "Sign in to alphaXiv so the /lit and paper-fetch tools can search, fetch, and annotate papers. Free account — no API key needed.",
      );
    header.descEl.addClass("feynman-oauth-desc");

    const row = section.createDiv({ cls: "feynman-oauth-row" });
    const labelBox = row.createDiv({ cls: "feynman-oauth-row-label" });
    labelBox.createDiv({ cls: "feynman-oauth-row-name", text: "alphaXiv" });
    const stateEl = labelBox.createDiv({ cls: "feynman-oauth-row-state" });
    stateEl.setText("Checking…");

    const actions = row.createDiv({ cls: "feynman-oauth-row-actions" });

    const reload = async (): Promise<void> => {
      const client = this.makeAuthClient();
      if (client === null) {
        stateEl.setText("Requires the local Docker backend.");
        actions.empty();
        return;
      }
      try {
        const status = await client.getAlphaStatus();
        actions.empty();
        if (status.loggedIn) {
          stateEl.removeClass("feynman-oauth-signed-in");
          stateEl.addClass("feynman-oauth-signed-in");
          stateEl.setText(status.userName ? `Signed in as ${status.userName}` : "Signed in");
          const reSign = actions.createEl("button", {
            text: "Re-sign in",
            attr: { type: "button" },
          });
          this.plugin.registerDomEvent(reSign, "click", () => this.openAlphaModal());
          const out = actions.createEl("button", {
            text: "Sign out",
            attr: { type: "button" },
          });
          this.plugin.registerDomEvent(out, "click", () => void this.signOutAlpha());
        } else {
          stateEl.removeClass("feynman-oauth-signed-in");
          stateEl.setText("Not signed in");
          const signIn = actions.createEl("button", {
            text: "Sign in",
            cls: "mod-cta",
            attr: { type: "button" },
          });
          this.plugin.registerDomEvent(signIn, "click", () => this.openAlphaModal());
        }
      } catch (err) {
        stateEl.setText(
          `Could not reach server — ${truncate(err instanceof Error ? err.message : String(err), 80)}`,
        );
        actions.empty();
        const retry = actions.createEl("button", {
          text: "Retry",
          attr: { type: "button" },
        });
        this.plugin.registerDomEvent(retry, "click", () => void reload());
      }
    };

    (section as unknown as { feynmanReload?: () => Promise<void> }).feynmanReload = reload;
    void reload();
  }

  private openAlphaModal(): void {
    const client = this.makeAuthClient();
    if (client === null) {
      new Notice("alphaXiv sign-in requires the local Docker backend.");
      return;
    }
    const modal = new OAuthLoginModal(this.app, {
      kind: "alpha",
      providerName: "alphaXiv",
      client,
      onComplete: () => {
        const section = this.containerEl.querySelector(
          ".feynman-alpha-section",
        ) as (HTMLElement & { feynmanReload?: () => Promise<void> }) | null;
        void section?.feynmanReload?.();
      },
    });
    modal.open();
  }

  private async signOutAlpha(): Promise<void> {
    const client = this.makeAuthClient();
    if (client === null) return;
    try {
      await client.alphaLogout();
      new Notice("Signed out of alphaXiv.");
      const section = this.containerEl.querySelector(
        ".feynman-alpha-section",
      ) as (HTMLElement & { feynmanReload?: () => Promise<void> }) | null;
      void section?.feynmanReload?.();
    } catch (err) {
      new Notice(
        `Sign-out failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
        "Stored in plaintext at ~/.feynman/secrets.json (mode 0600), outside the vault.",
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
            this.notePendingRestart();
          });
        });
      setting.descEl
        .createDiv({ cls: "feynman-warning" })
        .setText("Stored in plaintext at ~/.feynman/secrets.json (mode 0600), outside the vault.");
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
        : "icariansystems/feynman:1.0.0";
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
    // Wrap the whole tier in a highlighted card so it visually separates
    // from the rest of the settings (this is the only "promo" section).
    const card = host.createDiv({ cls: "feynman-cloud-card" });

    const headingRow = card.createDiv({ cls: "feynman-cloud-card-heading" });
    headingRow.createEl("h3", { text: "Feynman Cloud" });
    headingRow.createSpan({
      cls: "feynman-cloud-badge",
      text: "Coming soon",
    });

    card
      .createDiv({ cls: "feynman-cloud-card-body" })
      .setText(
        "Managed compute, managed keys, no Docker. Monthly subscription. " +
          "The hosted tier ships in a future release.",
      );

    if (this.plugin.settings.features.waitlist.enabled) {
      new Setting(card)
        .setName("Join the waitlist")
        .setDesc("Sign up to be notified when Feynman Cloud opens.")
        .addButton((b) =>
          b
            .setButtonText("Join waitlist")
            .setCta()
            .onClick(() => {
              new WaitlistModal(this.plugin.app).open();
            }),
        );
    }

    new Setting(card)
      .setName("License key")
      .setDesc("Available with the hosted tier. Disabled until then.")
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
    new Setting(host)
      .setName("Auto-open created documents")
      .setDesc(
        "When a run finishes, open the document(s) it wrote in new panes so you can review them immediately.",
      )
      .addDropdown((dd) => {
        dd.addOption("last", "Open the last document (recommended)");
        dd.addOption("all", "Open every document");
        dd.addOption("off", "Don't auto-open");
        dd.setValue(this.plugin.settings.autoOpenArtifacts);
        dd.onChange((v) => {
          this.plugin.settings.autoOpenArtifacts = v as
            | "off"
            | "last"
            | "all";
          this.queueSave();
        });
      });
  }
}
