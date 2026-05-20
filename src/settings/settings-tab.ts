// Settings tab. Sections enumerated in docs/ARCHITECTURE.md §8.4.
//
// First-run onboarding lives at the top of the tab. When the user hasn't yet
// picked a backend AND no server is reachable, the host plugin opens this
// tab automatically (see main.ts onload).

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FeynmanPlugin from "../../main";
import { WaitlistModal } from "../views/waitlist-modal";

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
    apiKeys: {
      anthropic?: string;
      openai?: string;
      exa?: string;
      perplexity?: string;
      gemini?: string;
    };
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
}

export const DEFAULT_SETTINGS: FeynmanSettings = {
  backend: "docker",
  docker: {
    imageTag: "latest",
    hostPort: 0,
    vaultMountPath: "",
    apiKeys: {},
  },
  selfHosted: { baseUrl: "", bearerToken: "" },
  modal: { licenseKey: "" },
  model: "",
  workspaceFolder: "Feynman/",
  onboardingCompleted: false,
};

export class FeynmanSettingTab extends PluginSettingTab {
  private readonly plugin: FeynmanPlugin;

  constructor(app: App, plugin: FeynmanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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
    this.renderSelfHosted(containerEl);
    this.renderModalTier(containerEl);
    this.renderWorkspace(containerEl);
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

    const dockerActions = dockerCard.createDiv({
      cls: "feynman-onboarding-card-actions",
    });
    const dockerBtn = dockerActions.createEl("button", {
      cls: "mod-cta",
      text: "Set up Docker",
      attr: { type: "button" },
    });
    dockerBtn.addEventListener("click", () => {
      this.plugin.settings.backend = "docker";
      void this.plugin.saveSettings();
      this.display();
      // Auto-scroll to the Docker section.
      const dockerHeader = host.querySelector(".feynman-section-docker");
      dockerHeader?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // --- Option 2: Feynman Cloud (placeholder) ------------------------
    const cloudCard = wrap.createDiv({
      cls: "feynman-onboarding-card feynman-onboarding-card-disabled",
    });
    cloudCard.createDiv({
      cls: "feynman-onboarding-card-title",
      text: "Feynman Cloud · coming soon",
    });
    cloudCard.createDiv({
      cls: "feynman-onboarding-card-body",
      text: "Managed compute, managed keys, no Docker. Monthly subscription. The hosted tier ships with v1.5 (M5 in ARCHITECTURE.md).",
    });
    const cloudActions = cloudCard.createDiv({
      cls: "feynman-onboarding-card-actions",
    });
    const cloudBtn = cloudActions.createEl("button", {
      text: "Join the waitlist",
      attr: { type: "button" },
    });
    cloudBtn.addEventListener("click", () => {
      new WaitlistModal(this.plugin.app).open();
    });

    // --- Test connection / Skip ---------------------------------------
    const footer = wrap.createDiv({ cls: "feynman-onboarding-footer" });
    const testBtn = footer.createEl("button", {
      text: "Test connection",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    testBtn.addEventListener("click", () => {
      void this.testConnection(testBtn);
    });

    const skipBtn = footer.createEl("button", {
      text: "I'll configure later",
      attr: { type: "button" },
    });
    skipBtn.addEventListener("click", () => {
      this.plugin.settings.onboardingCompleted = true;
      void this.plugin.saveSettings();
      this.plugin.refreshWorkflowsPane();
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
        this.plugin.settings.onboardingCompleted = true;
        await this.plugin.saveSettings();
        new Notice("Feynman: connected.");
        this.plugin.refreshWorkflowsPane();
        this.display();
      } else {
        new Notice(`Feynman: connection failed — ${result.error ?? "unknown"}`);
        btn.removeAttribute("disabled");
        btn.setText(original);
      }
    } catch (err) {
      new Notice(
        `Feynman: connection failed — ${err instanceof Error ? err.message : String(err)}`,
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
        dd.addOption("modal", "Feynman Cloud (coming soon)");
        dd.setValue(this.plugin.settings.backend);
        dd.onChange((v) => {
          this.plugin.settings.backend = v as FeynmanSettings["backend"];
          void this.plugin.saveSettings();
        });
      });
  }

  private renderDocker(host: HTMLElement): void {
    const head = new Setting(host).setName("Local Docker").setHeading();
    head.settingEl.addClass("feynman-section-docker");

    new Setting(host)
      .setName("Image tag")
      .setDesc("Docker image to use (defaults to feynman/server:dev).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.docker.imageTag)
          .onChange((v) => {
            this.plugin.settings.docker.imageTag = v;
            void this.plugin.saveSettings();
          }),
      );

    new Setting(host)
      .setName("Host port")
      .setDesc("Loopback port the container binds. 0 = auto.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.plugin.settings.docker.hostPort));
        t.onChange((v) => {
          const n = Number(v);
          this.plugin.settings.docker.hostPort = Number.isFinite(n) ? n : 0;
          void this.plugin.saveSettings();
        });
      });

    new Setting(host)
      .setName("Anthropic API key")
      .setDesc("Required. Passed into the container as ANTHROPIC_API_KEY.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-…");
        t.setValue(this.plugin.settings.docker.apiKeys.anthropic ?? "");
        t.onChange((v) => {
          this.plugin.settings.docker.apiKeys.anthropic = v;
          void this.plugin.saveSettings();
        });
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

  private renderSelfHosted(host: HTMLElement): void {
    new Setting(host).setName("Self-hosted").setHeading();

    new Setting(host)
      .setName("Base URL")
      .setDesc("e.g. https://feynman.your-domain.com")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.selfHosted.baseUrl)
          .onChange((v) => {
            this.plugin.settings.selfHosted.baseUrl = v;
            void this.plugin.saveSettings();
          }),
      );

    new Setting(host)
      .setName("Bearer token")
      .setDesc("Optional. Required if FEYNMAN_AUTH_TOKEN is set on the server.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.selfHosted.bearerToken);
        t.onChange((v) => {
          this.plugin.settings.selfHosted.bearerToken = v;
          void this.plugin.saveSettings();
        });
      });
  }

  private renderModalTier(host: HTMLElement): void {
    new Setting(host).setName("Feynman Cloud (coming soon)").setHeading();

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
            void this.plugin.saveSettings();
          }),
      );
  }
}
