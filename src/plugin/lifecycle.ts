// Plugin-lifecycle helpers extracted from main.ts (Wave 3 Agent 6).
// Keeps the entry point under the line budget while preserving the documented
// semantics (active-run drain with 2 s deadline, stale-resume pruning, etc.).

import { Notice, type App, type Workspace } from "obsidian";
import type { FeynmanClient, EventStream } from "../transport/client";
import {
  resumeWorkflow,
  type ActiveRunRegistry,
  type RunWorkflowDeps,
} from "../workflow-runner";
import {
  FeynmanWorkflowsView,
  VIEW_TYPE_FEYNMAN_WORKFLOWS,
} from "../views/workflows-view";

/** Resume entries older than this are pruned on load. */
export const RESUME_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Lexicographic semver compare over the leading three integer components.
 * Returns -1 if a<b, 0 equal, 1 if a>b. Pre-release tails ignored.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").slice(0, 3).map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").slice(0, 3).map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}
/** Per-run trailing debounce for persisting Last-Event-ID advances. */
export const LAST_EVENT_PERSIST_MS = 1000;
/** Outer deadline on the unload drain. */
const UNLOAD_DEADLINE_MS = 2000;

/**
 * Drain every active SSE run with a hard 2 s ceiling. Each run gets
 * best-effort `cancel(runId)` + `stream.close()` in parallel; failures are
 * swallowed so a hung cancel can't block plugin teardown.
 */
export async function drainActiveRuns(
  client: FeynmanClient | null,
  activeRuns: Map<string, { stream: EventStream; cleanup: () => void }>,
): Promise<void> {
  const runs = Array.from(activeRuns.entries());
  await Promise.race([
    Promise.allSettled(
      runs.map(([runId, { stream }]) =>
        Promise.allSettled([
          (async () => {
            try {
              await client?.cancel(runId);
            } catch {
              // ignore — best-effort cancel
            }
          })(),
          (async () => {
            try {
              stream.close();
            } catch {
              // ignore — stream.close() is idempotent
            }
          })(),
        ]),
      ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, UNLOAD_DEADLINE_MS)),
  ]);
  activeRuns.clear();
}

/**
 * Walk a persisted-runs map and reattach to anything still alive on the
 * server. Stale entries (>24 h) and 404s are pruned; the caller passes in a
 * `persist` callback so we don't take a hard dependency on the plugin class.
 *
 * Returns true if the persisted-runs collection was mutated (caller should
 * `saveSettings()`).
 */
export async function resumePersistedRuns(
  app: App,
  client: FeynmanClient,
  persistedRuns: Record<string, { lastEventId?: string; updatedAt: number }>,
  buildDeps: (registry: ActiveRunRegistry) => RunWorkflowDeps,
  registry: ActiveRunRegistry,
): Promise<boolean> {
  const cutoff = Date.now() - RESUME_STALE_MS;
  let dirty = false;
  for (const [runId, info] of Object.entries(persistedRuns)) {
    if (info.updatedAt < cutoff) {
      delete persistedRuns[runId];
      dirty = true;
      continue;
    }
    try {
      await resumeWorkflow(
        app,
        { runId, lastEventId: info.lastEventId },
        buildDeps(registry),
      );
    } catch {
      // 404 / network — drop the entry so we don't retry the same dead id.
      delete persistedRuns[runId];
      dirty = true;
    }
  }
  return dirty;
}

/** Reveal (or create) the workflows pane in the right sidebar. */
export async function openWorkflowsPane(workspace: Workspace): Promise<void> {
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

/** Health + manifest probe surfaced through a Notice (§8.1). Caller passes
 * its checkServerVersion + refreshWorkflowsPane hooks so this helper stays
 * free of plugin-class knowledge. */
export async function showStatus(
  client: FeynmanClient | null,
  setManifest: (m: import("../protocol").ManifestResponse) => void,
  checkServerVersion: (v: string) => void,
  refreshPane: () => void,
): Promise<void> {
  if (client === null) {
    new Notice("Feynman: client not initialized");
    return;
  }
  try {
    const [health, manifest] = await Promise.all([
      client.health(),
      client.manifest(),
    ]);
    setManifest(manifest);
    new Notice(
      `Feynman: ok=${String(health.ok)} version=${health.version} prompts=${manifest.prompts.length}`,
    );
    checkServerVersion(health.version);
    refreshPane();
  } catch (err) {
    new Notice(
      `Feynman: status failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
