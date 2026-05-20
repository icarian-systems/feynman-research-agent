// Waitlist signup modal for the Feynman Cloud tier. Posts to getwaitlist.com
// so we can gauge demand for the hosted (M5) tier before building it.

import { App, Modal, requestUrl } from "obsidian";

// https://getwaitlist.com/waitlist/32833
export const FEYNMAN_CLOUD_WAITLIST_ID = 32833;

const SIGNUP_ENDPOINT = "https://api.getwaitlist.com/api/v1/signup";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class WaitlistModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feynman-waitlist-modal");

    contentEl.createEl("h3", { text: "Join the Feynman Cloud waitlist" });
    contentEl.createEl("p", {
      cls: "feynman-waitlist-blurb",
      text: "Managed compute, managed keys, no Docker. We'll email you when the hosted tier opens up.",
    });

    const form = contentEl.createEl("form", { cls: "feynman-waitlist-form" });
    form.setAttr("novalidate", "true");

    const field = form.createDiv({ cls: "feynman-waitlist-field" });
    field.createEl("label", { text: "Email", attr: { for: "feynman-waitlist-email" } });
    const input = field.createEl("input", {
      cls: "feynman-waitlist-input",
      attr: {
        id: "feynman-waitlist-email",
        type: "email",
        placeholder: "you@example.com",
        autocomplete: "email",
        required: "true",
      },
    });

    const status = contentEl.createDiv({ cls: "feynman-waitlist-status" });

    const buttons = contentEl.createDiv({ cls: "feynman-waitlist-buttons" });
    const cancel = buttons.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    const submit = buttons.createEl("button", {
      text: "Join waitlist",
      cls: "mod-cta",
      attr: { type: "submit" },
    });

    // Modal isn't a Component; bare addEventListener is fine — contentEl
    // is dropped on close, releasing both elements and their listeners.
    cancel.addEventListener("click", () => this.close());

    const trySubmit = (ev: Event) => {
      ev.preventDefault();
      const email = input.value.trim();
      if (!EMAIL_RE.test(email)) {
        this.setStatus(status, "Enter a valid email address.", "error");
        input.focus();
        return;
      }
      void this.submitSignup(email, submit, cancel, input, status);
    };

    submit.addEventListener("click", trySubmit);
    form.addEventListener("submit", trySubmit);
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") trySubmit(ev);
    });

    // Focus the email field on open. setTimeout(0) — the modal is short-
    // lived and contentEl GCs on close.
    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private setStatus(
    el: HTMLElement,
    text: string,
    state: "info" | "error" | "success",
  ): void {
    el.empty();
    el.removeClass("is-error", "is-success", "is-info");
    el.addClass(`is-${state}`);
    el.setText(text);
  }

  private async submitSignup(
    email: string,
    submit: HTMLButtonElement,
    cancel: HTMLButtonElement,
    input: HTMLInputElement,
    status: HTMLElement,
  ): Promise<void> {
    submit.setAttr("disabled", "true");
    cancel.setAttr("disabled", "true");
    input.disabled = true;
    this.setStatus(status, "Joining…", "info");

    try {
      const res = await requestUrl({
        url: SIGNUP_ENDPOINT,
        method: "POST",
        contentType: "application/json",
        headers: { Accept: "application/json" },
        body: JSON.stringify({
          email,
          waitlist_id: FEYNMAN_CLOUD_WAITLIST_ID,
        }),
        throw: false,
      });

      if (res.status >= 200 && res.status < 300) {
        this.renderSuccess();
        return;
      }

      const errMsg = extractError(res.text) ?? `Signup failed (HTTP ${res.status}).`;
      this.setStatus(status, errMsg, "error");
    } catch (err) {
      this.setStatus(
        status,
        `Network error — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      submit.removeAttribute("disabled");
      cancel.removeAttribute("disabled");
      input.disabled = false;
    }
  }

  private renderSuccess(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("feynman-waitlist-modal");

    contentEl.createEl("h3", { text: "✓ You're on the list" });
    contentEl.createEl("p", {
      cls: "feynman-waitlist-blurb",
      text: "Thanks — we'll email you when Feynman Cloud is ready.",
    });
    const buttons = contentEl.createDiv({ cls: "feynman-waitlist-buttons" });
    const done = buttons.createEl("button", {
      text: "Close",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => this.close());
    window.setTimeout(() => done.focus(), 0);
  }
}

function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const candidates = ["error_string", "error", "message", "detail"];
    for (const key of candidates) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}
