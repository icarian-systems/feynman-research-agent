// Settings-derived helpers extracted from main.ts (Wave 3 Agent 6).
//
// Centralizes the three "resolve X from current settings" functions plus the
// duplicated app.setting?.open() block so main.ts can stay under the
// distribution target line budget. Imported back into main.ts.

import { Notice, type App } from "obsidian";
import type { VaultMode } from "../protocol";
import type { FeynmanSettings } from "./settings-tab";

/**
 * Resolve the base URL the transport client should hit, given the user's
 * configured backend. Modal mode returns a sentinel base; the matching
 * `resolveAuth` call returns null + a Notice so no live requests are made
 * against the half-configured tier.
 */
export function resolveBaseUrl(settings: FeynmanSettings): string {
  switch (settings.backend) {
    case "docker": {
      const port = settings.docker.hostPort > 0 ? settings.docker.hostPort : 7777;
      return `http://127.0.0.1:${port}`;
    }
    case "self-hosted":
      return settings.selfHosted.baseUrl;
    case "modal":
      // §6.3 — Modal tier is not yet shipped. We still surface a sentinel
      // base URL so callers don't crash, but resolveAuth's Modal branch
      // returns null + a Notice so no live requests are made.
      return "https://api.feynman.is";
    default: {
      const exhaustive: never = settings.backend;
      return exhaustive;
    }
  }
}

/**
 * Resolve the bearer token for the current backend, or null when no token is
 * available. Docker mode's token is minted by the supervisor on first start;
 * Modal mode short-circuits with a Notice (the dropdown disables Modal but a
 * previously-persisted value still routes through here).
 */
export function resolveAuth(settings: FeynmanSettings): string | null {
  switch (settings.backend) {
    case "docker":
      return settings.docker.authToken.length > 0
        ? settings.docker.authToken
        : null;
    case "self-hosted":
      return settings.selfHosted.bearerToken.length > 0
        ? settings.selfHosted.bearerToken
        : null;
    case "modal":
      new Notice("Feynman: Modal mode is not yet available");
      return null;
    default: {
      const exhaustive: never = settings.backend;
      return exhaustive;
    }
  }
}

/** Map the user-chosen backend onto the VaultMode the server expects. */
export function backendToVaultMode(
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

/**
 * Open the plugin's settings tab via Obsidian's non-public `app.setting` API.
 * Wrapped in try/catch so a future Obsidian release that removes the surface
 * surfaces a Notice instead of throwing. README documents the dependency.
 */
export function openPluginSettings(app: App, pluginId: string): void {
  try {
    const settingApi = (
      app as unknown as {
        setting?: {
          open?: () => void;
          openTabById?: (id: string) => void;
        };
      }
    ).setting;
    if (settingApi === undefined) {
      new Notice("Open Settings → Community plugins → Feynman");
      return;
    }
    settingApi.open?.();
    settingApi.openTabById?.(pluginId);
  } catch {
    new Notice("Open Settings → Community plugins → Feynman");
  }
}
