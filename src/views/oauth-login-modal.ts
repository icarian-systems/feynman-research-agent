// OAuth login modal. Drives the server's `/v1/auth/login/*` session for one
// provider: open the SSE stream, render whichever prompt the server emits
// (auth URL, free-text prompt, select, manual-code), and POST the response
// back. The modal is single-instance and owns one AbortController to tear
// the stream down on close.

import { App, Modal, Notice } from "obsidian";

import type { AuthClient, LoginEvent } from "../transport/auth-client";

type State =
  | { kind: "starting" }
  | { kind: "auth"; url: string; instructions?: string }
  | {
      kind: "prompt";
      promptId: string;
      message: string;
      placeholder?: string;
      allowEmpty: boolean;
    }
  | {
      kind: "select";
      promptId: string;
      message: string;
      options: { id: string; label: string }[];
    }
  | { kind: "manual_code"; promptId: string }
  | { kind: "progress"; message: string }
  | { kind: "complete" }
  | { kind: "error"; message: string };

export interface OAuthLoginModalOptions {
  /** "model" → model-provider OAuth via pi-ai; "alpha" → alphaXiv. */
  kind?: "model" | "alpha";
  /** Required when kind === "model"; ignored otherwise. */
  providerId?: string;
  providerName: string;
  client: AuthClient;
  onComplete?: () => void;
}

export class OAuthLoginModal extends Modal {
  private readonly client: AuthClient;
  private readonly kind: "model" | "alpha";
  private readonly providerId: string;
  private readonly providerName: string;
  private readonly onComplete?: () => void;

  private readonly abort = new AbortController();
  private sessionId: string | null = null;
  private state: State = { kind: "starting" };
  /** Most recent auth info — kept across other prompt events so the URL
   * stays visible when a subsequent prompt arrives. */
  private latestAuth: { url: string; instructions?: string } | null = null;
  /** Streaming progress lines accumulate so users see what the server is doing. */
  private readonly progressLog: string[] = [];

  constructor(app: App, opts: OAuthLoginModalOptions) {
    super(app);
    this.client = opts.client;
    this.kind = opts.kind ?? "model";
    this.providerId = opts.providerId ?? "";
    this.providerName = opts.providerName;
    this.onComplete = opts.onComplete;
  }

  override onOpen(): void {
    this.contentEl.addClass("feynman-oauth-modal");
    void this.start();
  }

  override onClose(): void {
    this.abort.abort();
    if (this.sessionId && this.state.kind !== "complete" && this.state.kind !== "error") {
      const cancelFn =
        this.kind === "alpha"
          ? this.client.cancelAlphaLogin.bind(this.client)
          : this.client.cancel.bind(this.client);
      // Best-effort: tell the server to drop the session if user closed mid-flow.
      void cancelFn(this.sessionId).catch(() => undefined);
    }
    this.contentEl.empty();
  }

  private async start(): Promise<void> {
    this.render();
    try {
      const start =
        this.kind === "alpha"
          ? await this.client.startAlphaLogin()
          : await this.client.startLogin(this.providerId);
      this.sessionId = start.sessionId;
    } catch (err) {
      this.state = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      this.render();
      return;
    }

    const stream = this.client.openEvents(this.sessionId, this.abort);
    try {
      for await (const ev of stream) {
        this.handleEvent(ev);
      }
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.state = {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        this.render();
      }
    }
  }

  private handleEvent(ev: LoginEvent): void {
    switch (ev.type) {
      case "auth":
        this.latestAuth = { url: ev.url, instructions: ev.instructions };
        this.state = { kind: "auth", url: ev.url, instructions: ev.instructions };
        break;
      case "prompt":
        this.state = {
          kind: "prompt",
          promptId: ev.promptId,
          message: ev.message,
          placeholder: ev.placeholder,
          allowEmpty: ev.allowEmpty ?? false,
        };
        break;
      case "select":
        this.state = {
          kind: "select",
          promptId: ev.promptId,
          message: ev.message,
          options: ev.options,
        };
        break;
      case "manual_code":
        this.state = { kind: "manual_code", promptId: ev.promptId };
        break;
      case "progress":
        this.progressLog.push(ev.message);
        this.state = { kind: "progress", message: ev.message };
        break;
      case "complete":
        this.state = { kind: "complete" };
        new Notice(`Signed in to ${this.providerName}.`);
        this.onComplete?.();
        break;
      case "error":
        this.state = { kind: "error", message: ev.message };
        break;
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", {
      text: `Sign in to ${this.providerName}`,
    });

    if (this.latestAuth && this.state.kind !== "complete" && this.state.kind !== "error") {
      this.renderAuthBox(this.latestAuth.url, this.latestAuth.instructions);
    }

    if (this.progressLog.length > 0 && this.state.kind !== "complete") {
      this.renderProgressLog();
    }

    switch (this.state.kind) {
      case "starting":
        contentEl.createDiv({
          cls: "feynman-oauth-status",
          text: "Starting login session…",
        });
        break;
      case "auth":
        // The URL is already rendered above; show a hint about what the user
        // should do next.
        contentEl.createDiv({
          cls: "feynman-oauth-status",
          text: "Complete the sign-in in your browser, then return here.",
        });
        break;
      case "prompt":
        this.renderPrompt(this.state.message, this.state.placeholder, this.state.promptId, false);
        break;
      case "manual_code":
        this.renderPrompt(
          "Paste the redirect URL or auth code from your browser:",
          "https://…  or  abc123",
          this.state.promptId,
          true,
        );
        break;
      case "select":
        this.renderSelect(this.state.message, this.state.options, this.state.promptId);
        break;
      case "progress":
        contentEl.createDiv({
          cls: "feynman-oauth-status",
          text: this.state.message,
        });
        break;
      case "complete":
        this.renderComplete();
        break;
      case "error":
        this.renderError(this.state.message);
        break;
    }

    if (this.state.kind !== "complete" && this.state.kind !== "error") {
      const footer = contentEl.createDiv({ cls: "feynman-oauth-footer" });
      const cancel = footer.createEl("button", {
        text: "Cancel",
        attr: { type: "button" },
      });
      cancel.addEventListener("click", () => this.close());
    }
  }

  private renderAuthBox(url: string, instructions?: string): void {
    const box = this.contentEl.createDiv({ cls: "feynman-oauth-auth-box" });
    if (instructions) {
      box.createDiv({ cls: "feynman-oauth-instructions", text: instructions });
    }
    const urlRow = box.createDiv({ cls: "feynman-oauth-url-row" });
    urlRow.createEl("code", { cls: "feynman-oauth-url", text: url });
    const actions = box.createDiv({ cls: "feynman-oauth-url-actions" });
    const openBtn = actions.createEl("button", {
      text: "Open in browser",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    openBtn.addEventListener("click", () => {
      try {
        window.open(url, "_blank");
      } catch {
        new Notice("Could not open browser — copy the URL above instead.");
      }
    });
    const copyBtn = actions.createEl("button", {
      text: "Copy URL",
      attr: { type: "button" },
    });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(url).then(
        () => new Notice("URL copied."),
        () => new Notice("Copy failed — select the URL manually."),
      );
    });
  }

  private renderProgressLog(): void {
    const log = this.contentEl.createDiv({ cls: "feynman-oauth-progress-log" });
    log.createEl("strong", { text: "Status" });
    const ul = log.createEl("ul");
    for (const line of this.progressLog) {
      ul.createEl("li", { text: line });
    }
  }

  private renderPrompt(
    message: string,
    placeholder: string | undefined,
    promptId: string,
    allowMultiline: boolean,
  ): void {
    const box = this.contentEl.createDiv({ cls: "feynman-oauth-prompt" });
    box.createDiv({ cls: "feynman-oauth-prompt-message", text: message });
    const input = allowMultiline
      ? box.createEl("textarea", {
          cls: "feynman-oauth-input",
          attr: {
            rows: "3",
            placeholder: placeholder ?? "",
          },
        })
      : box.createEl("input", {
          cls: "feynman-oauth-input",
          attr: {
            type: "text",
            placeholder: placeholder ?? "",
          },
        });
    const submit = box.createEl("button", {
      text: "Submit",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    const trySubmit = (): void => {
      const value = "value" in input ? input.value : "";
      submit.setAttr("disabled", "true");
      submit.setText("Submitting…");
      void this.submitResponse(promptId, value).catch((err: unknown) => {
        new Notice(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
        submit.removeAttribute("disabled");
        submit.setText("Submit");
      });
    };
    submit.addEventListener("click", trySubmit);
    (input as HTMLElement).addEventListener("keydown", (ev: Event) => {
      const ke = ev as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey && !allowMultiline) {
        ke.preventDefault();
        trySubmit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private renderSelect(
    message: string,
    options: { id: string; label: string }[],
    promptId: string,
  ): void {
    const box = this.contentEl.createDiv({ cls: "feynman-oauth-select" });
    box.createDiv({ cls: "feynman-oauth-prompt-message", text: message });
    const list = box.createDiv({ cls: "feynman-oauth-select-list" });
    for (const opt of options) {
      const btn = list.createEl("button", {
        text: opt.label,
        cls: "feynman-oauth-select-option",
        attr: { type: "button" },
      });
      btn.addEventListener("click", () => {
        btn.setAttr("disabled", "true");
        void this.submitResponse(promptId, opt.id).catch((err: unknown) => {
          new Notice(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
          btn.removeAttribute("disabled");
        });
      });
    }
  }

  private renderComplete(): void {
    this.contentEl.createDiv({
      cls: "feynman-oauth-status feynman-oauth-success",
      text: `✓ Signed in to ${this.providerName}.`,
    });
    const footer = this.contentEl.createDiv({ cls: "feynman-oauth-footer" });
    const done = footer.createEl("button", {
      text: "Done",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => this.close());
    window.setTimeout(() => done.focus(), 0);
  }

  private renderError(message: string): void {
    this.contentEl.createDiv({
      cls: "feynman-oauth-status feynman-oauth-error",
      text: `Login failed: ${message}`,
    });
    const footer = this.contentEl.createDiv({ cls: "feynman-oauth-footer" });
    const close = footer.createEl("button", {
      text: "Close",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    close.addEventListener("click", () => this.close());
  }

  private async submitResponse(promptId: string, value: string): Promise<void> {
    if (!this.sessionId) throw new Error("no active session");
    await this.client.respond(this.sessionId, promptId, value);
  }
}
