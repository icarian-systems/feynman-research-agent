// Co-located helper that builds the WorkflowsViewDeps snapshot the
// workflows pane needs. Extracted from main.ts (Wave 3 Agent 6) so the
// plugin entry stays small.

import type FeynmanPlugin from "../../main";
import { FeynmanClient } from "../transport/client";
import {
  resolveBaseUrl,
  resolveAuth,
  backendToVaultMode,
  openPluginSettings,
} from "../settings/derive";
import type { WorkflowsViewDeps } from "./workflows-view";

/**
 * Snapshot the state the workflows pane needs to render + run.
 * Reads live from `plugin.settings` / `plugin.client` / `plugin.serverManifest`
 * so the pane always sees the latest values without a refresh dance.
 */
export function getWorkflowsDeps(plugin: FeynmanPlugin): WorkflowsViewDeps {
  const baseUrl = resolveBaseUrl(plugin.settings);
  return {
    client:
      plugin.client ??
      new FeynmanClient({
        baseUrl,
        getAuth: () => resolveAuth(plugin.settings),
        clientVersion: plugin.manifest.version,
      }),
    manifest: plugin.serverManifest,
    getVaultMode: () => backendToVaultMode(plugin.settings.backend),
    getModel: () =>
      plugin.settings.model.length > 0 ? plugin.settings.model : undefined,
    serverOk: plugin.serverManifest !== null,
    serverLabel: `${plugin.settings.backend} · ${baseUrl.replace(/^https?:\/\//, "")}`,
    versionError: plugin.serverVersionError ?? undefined,
    openSettings: () => openPluginSettings(plugin.app, plugin.manifest.id),
    registry: plugin,
    onLastEventIdAdvance: (runId, eventId) =>
      plugin.recordLastEventId(runId, eventId),
  };
}
