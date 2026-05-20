# Feynman — Obsidian Plugin Architecture

> Status: design document. The plugin and supporting servers do not exist yet; this file is the blueprint for building them.

## 1. Why this exists

Feynman today is a CLI research agent for academics, built as a thin shell over the Pi agent runtime (`@mariozechner/pi-coding-agent`). The product surface is already file-shaped — `outputs/`, `notes/`, `papers/`, `CHANGELOG.md`, prompts as `.md`, skills as directories with `SKILL.md` — and the workflows (`/deepresearch`, `/lit`, `/audit`, `/replicate`, `/recipe`, `/review`, `/compare`, `/draft`, `/autoresearch`, `/watch`) are already the unit of work researchers actually use.

The CLI works, but it is the wrong shell for the audience. Academics live in Obsidian (or PKM tools like it). They want to launch a literature review from a note, see the agent's reasoning stream into a pane, click an output and have it open as a vault note, and link the result into their existing graph. The CLI's TTY model fights all of that.

This document describes how Feynman becomes an Obsidian plugin without throwing away the agent runtime. Three deployment modes are supported, so users with different constraints can all run it:

1. **Local Docker** — plugin pulls and runs a Docker image on the user's machine. BYO API keys. Free.
2. **Self-hosted** — user runs the same image on their own infrastructure (homelab, VPS, university server). BYO API keys. Free.
3. **Managed Modal** — paid monthly subscription via Lemon Squeezy; a Modal-hosted endpoint serves the agent. Managed keys, managed compute, managed updates.

The CLI is kept as a first-class surface so existing users are not disrupted.

## 2. Foundational decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Plugin repo location | Separate repo (`feynman-obsidian`) | Plugin release cadence and platform constraints (Electron, Obsidian APIs) are different from the agent runtime. Plugin consumes the agent only over HTTP+SSE. |
| Transport | HTTP + SSE on a small `/v1/*` surface | One client implementation works against all three backends. Trivially proxies through Modal/Cloudflare/nginx. WebSocket upgrade quirks avoided. |
| Process model | Server spawns Pi in `--mode rpc` (`src/pi/runtime.ts:19`, `src/pi/launch.ts:48`) | Pi already supports a structured stdio protocol; the server is a thin NDJSON → SSE fan-out, not a fork of Pi. |
| v1 scope | All existing prompts and skills, generic input modal + streaming output pane | Lowest UI investment that still ships the whole tool. Bespoke per-workflow UI can land later as a non-breaking add. |
| Billing | Lemon Squeezy subscription + license key | EU-friendly (handles VAT), license-key API and webhooks are well-documented, no merchant-of-record overhead. |

## 3. High-level architecture

```
┌──────────────────────────── Obsidian (Electron) ────────────────────────────┐
│                                                                              │
│   feynman-obsidian plugin                                                    │
│   ├─ commands         (dynamic registration from /v1/manifest)              │
│   ├─ chat view        (streaming pane, slash-commands, tool approvals)      │
│   ├─ artifact view    (browses outputs/, papers/, notes/ inside the vault)  │
│   ├─ settings tab     (backend mode, keys, model picker, search provider)   │
│   ├─ transport        (HTTP + SSE client, reconnect, auth)                  │
│   └─ docker supervisor (only used in Local Docker mode)                     │
│                                                                              │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │  HTTPS  /  HTTP (loopback)
                                       │  POST /v1/run
                                       │  GET  /v1/runs/:id/events  (SSE)
                                       │  POST /v1/runs/:id/input
                                       │  GET  /v1/manifest
                                       │  GET  /v1/health
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
   ┌────────▼─────────┐      ┌─────────▼────────┐       ┌────────▼─────────┐
   │ Local Docker     │      │ Self-hosted      │       │ Managed Modal    │
   │ (this machine)   │      │ (user infra)     │       │ (paid)           │
   │                  │      │                  │       │                  │
   │ feynman-server   │      │ feynman-server   │       │ feynman-server   │
   │  + Pi (rpc)      │      │  + Pi (rpc)      │       │  + Pi (rpc)      │
   │  + skills        │      │  + skills        │       │  + skills        │
   │  + prompts       │      │  + prompts       │       │  + prompts       │
   │                  │      │                  │       │                  │
   │ Vault mounted    │      │ Vault NOT mounted│       │ Vault NOT mounted│
   │ at /vault        │      │ Sandbox or       │       │ FS-bridge over   │
   │ Direct FS access │      │  FS-bridge       │       │  SSE channel     │
   │                  │      │                  │       │                  │
   │ BYO API keys     │      │ BYO API keys     │       │ Managed keys     │
   │ (env at start)   │      │ (env at start)   │       │ (Modal secrets)  │
   │                  │      │                  │       │ License-gated    │
   └──────────────────┘      └──────────────────┘       └────────┬─────────┘
                                                                  │
                                                          ┌───────▼────────┐
                                                          │ Lemon Squeezy  │
                                                          │ License API    │
                                                          │ + webhooks     │
                                                          └────────────────┘
```

## 4. Package and repository split

### 4.1 This repo (`feynman`) — agent runtime + servers

Convert from a single-package CLI to an npm workspace. Each package below is publishable.

| Package | Path | Purpose |
| --- | --- | --- |
| `@feynman/core` | `packages/core/` | Pi launch + RPC bridge, runtime patches, skill/prompt/extension loaders, config paths. Library, no CLI. |
| `@feynman/cli` | `packages/cli/` | Today's CLI, repackaged on top of `@feynman/core`. The `feynman` binary keeps working as-is. |
| `@feynman/server` | `packages/server/` | HTTP+SSE server. Spawns Pi in `--mode rpc`, fans events out as SSE, accepts input via POST. Image entry point. |
| `@feynman/extensions` | `packages/extensions/` (was `extensions/`) | Pi extensions (alphaXiv, Hugging Face, model picker, init/help/outputs). Server loads these by default. |
| `@feynman/prompts` | `packages/prompts/` (was `prompts/`) | Slash-command workflows. Published for tooling/discovery. |
| `@feynman/protocol` | `packages/protocol/` | **Types only** — wire shapes for `/v1/*` and SSE events. Shared with the plugin repo so the plugin never imports Pi. |
| Docker image | `docker/` | `Dockerfile` building `feynman/server:<version>`. Multi-arch (amd64, arm64). Pushed to GHCR. |
| Modal app | `modal/` | `feynman_modal.py` deploys `@feynman/server` as a Modal web endpoint with auth middleware + Lemon Squeezy verification. Operator-only artifact; users never see it. |

`metadata/commands.mjs` becomes `packages/core/src/manifest.ts` (typed) — the single source for both `feynman --help` and `/v1/manifest`.

`skills/` stays at the repo root and is referenced via the `pi.skills` field in `packages/server/package.json` (same mechanism the CLI uses today).

`.feynman/SYSTEM.md` and `.feynman/agents/*.md` ship as `packages/server/assets/` and are copied into the image at build time. No content changes.

### 4.2 New repo (`feynman-obsidian`) — the plugin

Standard Obsidian-plugin layout (esbuild, `manifest.json`, `main.ts`). The plugin imports only `@feynman/protocol` (types-only) — Pi never loads in the renderer.

```
feynman-obsidian/
├── manifest.json
├── main.ts                       # plugin entry; loads settings, registers commands from /manifest
├── src/
│   ├── transport/
│   │   ├── client.ts             # POST /v1/run, SSE consumer, reconnect
│   │   └── auth.ts               # bearer / license-key header injection
│   ├── docker/
│   │   ├── supervisor.ts         # docker run / stop / health; only loaded in Local Docker mode
│   │   └── prefs.ts              # image tag, port, mounts
│   ├── views/
│   │   ├── chat-view.ts          # ItemView, primary research surface
│   │   ├── artifact-view.ts      # tree of outputs/, papers/, notes/
│   │   └── tool-approval.ts      # modal for tool calls requesting confirmation
│   ├── commands/
│   │   └── register.ts           # one Obsidian command per prompt slug returned by /manifest
│   ├── settings/
│   │   └── settings-tab.ts
│   └── fs-bridge/
│       └── handler.ts            # responds to fs.read/write events (self-host & Modal modes)
├── styles.css
└── README.md
```

## 5. Wire protocol

Mode-agnostic. Same wire for Docker / self-host / Modal — only base URL and auth differ.

### 5.1 Endpoints

```
GET  /v1/health                    → { ok: true, version: "..." }
GET  /v1/manifest                  → { prompts: [...], skills: [...], models: [...], capabilities: { vaultModes, fsBridge, artifactPull, usage? } }
POST /v1/run                       → { runId, eventsUrl }
                                     body: { prompt, args, vaultMode, model?, context? }
GET  /v1/runs/:id                  → { runId, status, startedAt, lastEventId }
GET  /v1/runs/:id/events           → SSE stream; honors `Last-Event-ID` header to resume mid-run
POST /v1/runs/:id/input            → body: { type: "approval" | "answer", payload }
POST /v1/runs/:id/cancel           → 204
GET  /v1/runs/:id/artifacts/:path  → file contents (sandbox-mode pull)
POST /v1/license/activate          → bind a Lemon Squeezy license to this plugin instance (Modal only)
```

### 5.2 SSE event types

A direct mirror of Pi's `--mode rpc` NDJSON, plus a small overlay for filesystem bridging and artifact notifications.

```ts
type EventPayload =
  | { type: "agent.message"; role: "assistant" | "system"; markdown: string }
  | { type: "agent.thinking"; markdown: string }            // streamed deltas
  | { type: "agent.question"; questionId: string; markdown: string }  // server prompts user; client replies via Input.answer with the same questionId
  | { type: "tool.call"; toolId: string; name: string; args: unknown }
  | { type: "tool.result"; toolId: string; ok: boolean; preview?: string }
  | { type: "tool.approval_required"; toolId: string; title: string; args: unknown }  // `title` is the confirmation prompt shown to the user; not necessarily a tool identifier (the underlying agent runtime may emit extension-scoped confirms whose "tool name" doesn't exist)
  | { type: "fs.read_request"; reqId: string; path: string }   // self-host + Modal
  | { type: "fs.write_request"; reqId: string; path: string; content: string }
  | { type: "artifact.written"; path: string; bytes: number }
  | { type: "run.error"; message: string; code?: string }
  | { type: "run.done"; exitCode: number; summary?: string };

type Event = EventPayload & {
  id: number;   // monotonic per run; emitted on the SSE `id:` line so clients reconnect via Last-Event-ID
  ts: number;   // server wall clock, ms since epoch
};
```

Plugin → server replies (POST `/v1/runs/:id/input`):

```ts
type Input =
  | { type: "approval"; toolId: string; decision: "allow" | "allow_once" | "deny" }
  | { type: "answer"; questionId: string; markdown: string }
  | { type: "fs.read_response"; reqId: string; content: string | null }
  | { type: "fs.write_response"; reqId: string; ok: boolean };
```

### 5.3 Why HTTP + SSE, not WebSocket

- Proxies cleanly through Modal/Cloudflare/nginx; no WS upgrade negotiation.
- One-way streaming matches the agent loop. The handful of client→server events (approvals, fs-bridge responses) are short POSTs, which is fine.
- Identical client code in Node tests, the Electron renderer, and a future web client.

### 5.4 Reconnect and event durability

Long-lived SSE streams die for mundane reasons: laptop sleep, Wi-Fi switch, corporate proxy idle timeouts (commonly 30–300 s), Obsidian renderer reload. The server must let clients pick the stream back up without losing events.

- The server buffers per-run events in memory keyed by `runId`, capped at the last N events (default 1 000) or until `run.done` plus a 5-minute grace.
- Every event carries a monotonic `id`, emitted on the SSE `id:` line. The standard EventSource reconnect sends `Last-Event-ID`; the server replays events with `id > Last-Event-ID` and then resumes live.
- Keepalives: server emits an SSE comment (`:keepalive\n\n`) every 10 s to defeat idle-timeout proxies.
- If a client reconnects after the buffer has been evicted, the server returns `409 Gone`; the client fetches `GET /v1/runs/:id` for terminal state and surfaces a "stream lost, run continued" notice rather than re-streaming.
- `POST /v1/runs/:id/input` is idempotent on `(toolId | reqId | questionId)` so retries after a flaky network don't double-approve or double-answer.
- **Partial-window eviction.** The 1000-event cap is per-run lifetime. If a reconnecting client's `Last-Event-ID` falls below the buffer's oldest retained id, the server returns `409 Gone` rather than a silent partial replay — the client cannot tell which events it missed, so the only honest answer is "stream lost". Clients respond exactly as they do for post-grace eviction: fetch `GET /v1/runs/:id` for terminal state and surface a notice.
- **Terminal events are the iterator terminus.** A client that observes `run.done` or `run.error` for a `runId` MUST stop reconnecting that stream. The server closes the body after writing terminal events, but a client treating socket-close as "drop and retry" will reopen, hit a buffer that no longer accepts new events, and then 409 after the 5-minute grace. Treat the terminal frame as end-of-iteration on the client side.

### 5.5 Server contract invariants

Properties every conforming `@feynman/server` enforces regardless of mode:

- **`vaultMode` rejection.** `POST /v1/run` returns `400 Bad Request` if `req.vaultMode` is not in `capabilities.vaultModes` from the same server's `/v1/manifest`. This catches misconfigured plugins (e.g. a self-hosted server receiving a `docker` request) early instead of surfacing as an obscure mid-run failure.
- **`context` token gating (§8.1).** `POST /v1/run` rejects (`400 Bad Request`) any token in `req.context` that the prompt's `ManifestEntry.context` does not declare. The plugin enforces this client-side too, but the server is authoritative.
- **Idempotency.** `POST /v1/runs/:id/input` deduplicates on the relevant id (`toolId` for approval, `questionId` for answer, `reqId` for `fs.*_response`). Retries are safe.

## 6. Deployment modes

### 6.1 Local Docker

**Image:** `ghcr.io/<org>/feynman-server:<version>`, multi-arch (amd64, arm64), built from `packages/server/Dockerfile`.

**First-run flow** (driven from settings tab):

1. User picks "Local Docker".
2. Plugin checks `docker --version`. If missing, settings shows install instructions and refuses to proceed.
3. Plugin pulls the image, surfacing progress through Obsidian notices.
4. Plugin starts the container:
   ```
   docker run -d --name feynman-server-<vaultId> \
     -p 127.0.0.1:7777:7777 \
     -v "<vault path>:/vault" \
     -e FEYNMAN_VAULT=/vault \
     -e FEYNMAN_AUTH_TOKEN=<random> \
     -e ANTHROPIC_API_KEY=<if user pasted> \
     -e EXA_API_KEY=<if user pasted> \
     ghcr.io/<org>/feynman-server:<version>
   ```
5. Plugin polls `GET /v1/health` until ready, then fetches `/v1/manifest` and registers commands.

**Vault access:** direct. Pi's `cwd` is `/vault`, so `outputs/`, `notes/`, `papers/` land inside the vault. No FS-bridge needed.

**`vaultId` definition:** Obsidian exposes `this.app.appId` — a stable hash unique to the vault. The plugin uses this verbatim as `<vaultId>` so multiple open vaults each get their own container (`feynman-server-<appId>`) and host port (see also §12 multi-vault). Falls back to a SHA-1 of the vault's absolute path on the rare Obsidian builds where `appId` is missing.

**Supervisor:** plugin tracks the container by name (`feynman-server-<vaultId>`) and offers stop / restart / "pull latest" actions in settings. Detects upgrades by comparing `manifest.version` to the latest published tag.

**Auth:** container listens on `127.0.0.1` only. Plugin generates a random bearer token at container start and passes it in `Authorization:` on every request — defence-in-depth against other processes on the box.

### 6.2 Self-hosted

Same image, same protocol, run by the user somewhere else.

**Plugin needs:** base URL and an optional bearer token (`FEYNMAN_AUTH_TOKEN` env on the server).

**Vault access:** the remote server has no view of the user's vault. Two options:

- **Sandbox mode (v1 default).** Server writes to its own working dir. As artifacts are written, the server emits `artifact.written` events; the plugin pulls each via `GET /v1/runs/:id/artifacts/:path` and writes the content into the vault. Simpler and good enough for write-heavy workflows.
- **FS-bridge mode (v2).** Server emits `fs.read_request`/`fs.write_request`; plugin services them against the vault in real time. Required for workflows that read existing vault notes mid-run (e.g. literature reviews scoped to "everything I've already collected").

**Tradeoff:** without FS-bridge, the "agent edits my notes in real time" feel is lost. The settings tab points users toward Local Docker if they want that experience.

### 6.3 Managed Modal (paid)

Same image, deployed as a Modal web endpoint. Architecture sketch:

```python
# modal/feynman_modal.py
import modal

app = modal.App("feynman-managed")
image = modal.Image.from_registry("ghcr.io/<org>/feynman-server:latest")

@app.cls(
    image=image,
    secrets=[modal.Secret.from_name("feynman-llm-keys")],
    container_idle_timeout=300,
)
class Feynman:
    @modal.web_endpoint(method="GET", custom_domains=["api.feynman.is"])
    def manifest(self): ...
    # /v1/run starts a per-session container; SSE proxied via modal.functions.
```

> **Open risk — must spike before M2.** Modal web endpoints are tuned for short request/response, not long-lived bidirectional sessions. A single `runId` must keep an SSE stream open *and* receive `POST /v1/runs/:id/input` on the *same* container instance — Modal's default routing does not guarantee this. The likely shape is a thin broker (Cloudflare Worker or fly.io app) that terminates SSE and forwards both directions to a Modal sandbox keyed by `runId`, with the Pi process pinned inside that sandbox for the run's lifetime. Until this is prototyped end-to-end (see M1 in §10), the Modal-mode timeline in §10 should be treated as speculative — a negative result here rewrites M5 and may push some Modal users toward self-hosted instead.

**Billing and auth flow:**

1. User buys a subscription at a Lemon Squeezy storefront (`feynman.lemonsqueezy.com`).
2. Lemon Squeezy issues a **license key**. Webhooks (`subscription_created`, `subscription_cancelled`, `subscription_payment_failed`) hit a small Modal function that caches license state in a Modal Dict / KV.
3. In the plugin's settings tab, the user pastes the license key. Plugin calls `POST /v1/license/activate`, which calls Lemon Squeezy's `activateLicense` instance API to bind the key to a plugin-instance hash. This caps how many devices a single license can run on.
4. Every `/v1/run` request includes `Authorization: Bearer <license>`. Server middleware:
   - KV hit (`active` | `grace` | `expired`) → accept or 402.
   - KV miss → one `validateLicense` call to Lemon Squeezy, cache for 6 h.
5. Settings UI surfaces subscription state (Active / Past Due / Cancelled) plus next renewal date pulled from `validateLicense`'s response.

**Vault access:** always FS-bridge — the Modal container has no vault. Same code path as self-host FS-bridge mode.

**Keys and compute:** a Modal-side secret holds Anthropic, Exa, Perplexity, etc. Managed users do not paste their own API keys — that's the value proposition. Usage is metered per license via the KV; caps are returned in `/v1/manifest.capabilities.usage` so the plugin can render a "73 % of monthly budget used" meter.

## 7. Vault as the working directory

In every mode, the agent's working directory is `$FEYNMAN_VAULT` (Docker: `/vault`; Modal: a per-session scratch dir). The existing layout maps cleanly:

| Existing path | Vault mapping |
| --- | --- |
| `outputs/` | `<vault>/Feynman/outputs/` |
| `papers/` | `<vault>/Feynman/papers/` |
| `notes/` | `<vault>/Feynman/notes/` |
| `CHANGELOG.md` | `<vault>/Feynman/CHANGELOG.md` |
| `.feynman/` | `<vault>/.feynman/` (hidden by Obsidian by default) |

The folder name is configurable in settings (default `Feynman/`). The plugin creates it on first run. Prompts already reference these paths relatively, so no prompt rewrites are needed.

### 7.1 Coexistence with vault sync

Obsidian Sync, iCloud Drive, Syncthing, Dropbox and friends all watch the vault. When the agent writes a long markdown file over the course of a streaming run, sync engines can pick up the in-progress file, ship a half-written copy to other devices, and produce conflict files when the final write arrives. Mitigations baked into the design:

- The server (Docker mode) and the plugin (FS-bridge mode) write to `Feynman/.staging/<runId>/<path>` and atomically rename into the destination on `run.done` or per-artifact completion. Sync engines observe a single create, not N appends.
- For artifacts the user wants to watch grow (an outline, a draft), the chat view renders directly from SSE state; nothing lands on disk until the artifact closes. Intermediate snapshots live under `.staging/` and never inside `Feynman/outputs|papers|notes/`.
- Settings detects common sync providers in the vault root (`.obsidian/sync`, `.icloud`, `.stfolder`, …) and surfaces a one-line note explaining the staging behavior — and warning that disabling staging is at the user's own risk.

`.feynman/` is itself a sync hazard: some providers skip dotfiles, others sync them unreliably. Treat it as machine-local — the image regenerates it from `packages/server/assets/` on boot, so losing it is recoverable.

**Implementation milestone.** Staging is **M3 work**. In v1 Docker mode (M2 verify), Pi runs with `cwd = $FEYNMAN_VAULT` and writes directly into `Feynman/outputs|notes|papers/` during streaming — so any user with a vault sync engine running will see conflict files on long workflows. Settings surfaces the warning per the third bullet above; the M3 deliverable wraps Pi's filesystem so writes route through `.staging/` and atomic-rename. Until then: the warning is the mitigation.

## 8. Plugin UX (v1)

### 8.1 Command palette

On startup, the plugin fetches `/v1/manifest` and registers an Obsidian command for every prompt:

- `Feynman: Deep research…` → generic input modal (topic + optional args) → `POST /v1/run` → chat view streams the result.
- `Feynman: Literature review…`, `Feynman: Audit…`, `Feynman: Replicate…`, `Feynman: Recipe…`, `Feynman: Review…`, `Feynman: Compare…`, `Feynman: Draft…`, `Feynman: Autoresearch…`, `Feynman: Watch…`.
- `Feynman: Open chat` — REPL-style; slash-commands work inside.
- `Feynman: Server status` — mode-specific diagnostics (container state, license state, latency).

The input modal is generic: it reads each prompt's frontmatter `args` from the manifest and renders matching form fields. No bespoke per-workflow UI in v1.

**Active-note context.** Manifest entries may declare `context: ("activeFile" | "selection" | "openTabs")[]`. When a user invokes the command, the plugin captures the matching editor state and includes it in the `POST /v1/run` body as `context`:

```ts
type RunContext = {
  activeFile?: { path: string; content: string; frontmatter?: Record<string, unknown> };
  selection?:  { path: string; text: string; range: { from: number; to: number } };
  openTabs?:   { path: string }[];
};
```

Invoking `Feynman: Review this paper` while a paper-companion note is open passes the note's contents as the review target — no copy-paste into a modal. Prompts opt in per token; defaulting to "always send active file" would leak context into runs that don't want it. Server logs reject any `context` field whose tokens the manifest does not declare, so the boundary is enforced.

**Frontmatter encoding.** A prompt opts into context tokens via its `.md` frontmatter:

```yaml
---
title: Review this paper
context: [activeFile, selection]
---
```

Accepted forms: YAML list (`[activeFile, selection]`), block list, or comma-separated string (`activeFile, selection`). Unknown tokens are dropped with a server-side warning. The manifest builder reads this field per prompt; absent/empty `context:` means the prompt receives no editor state and the plugin captures none.

### 8.2 Chat view (`ItemView`)

- Each `agent.message` is one chat block. While the message streams, the block renders as a plain-text `<pre>` updated per delta; on the closing event (or after 250 ms of stream idle) the block re-renders through `MarkdownRenderer.renderMarkdown` to pick up code-fence highlighting, links, and embeds. `MarkdownRenderer.renderMarkdown` is not incremental — re-running it per token janks the renderer, so the hybrid plain-then-markdown swap is the v1 contract.
- `agent.thinking` streams into a collapsed, dim block attached to the message it precedes; never re-rendered as full markdown.
- Tool calls render as collapsible blocks; `tool.approval_required` opens a modal with Allow / Allow once / Deny.
- `artifact.written` posts a clickable link that opens the file in Obsidian.

### 8.3 Artifact view

A tree over `Feynman/outputs|papers|notes` with one-click open. Pure vault read — no server calls.

### 8.4 Settings tab

Sections:

1. **Backend** — radio: Local Docker / Self-hosted / Managed Modal.
2. **Local Docker** — image tag, port, vault mount path, "pull latest", container state, BYO API keys (Anthropic, OpenAI, Exa, Perplexity, Gemini).
3. **Self-hosted** — base URL, bearer token, "test connection".
4. **Managed Modal** — license key, status pill, renewal date, usage meter, "open billing portal".
5. **Model** — picker populated from `/v1/manifest.models[]` (parity with today's `feynman model`).
6. **Workspace** — Feynman folder path inside the vault.

## 9. Refactor work in this repo

Concrete file moves and extractions for milestone M0:

| Today | After M0 |
| --- | --- |
| `src/index.ts`, `src/cli.ts`, `src/setup/`, `src/ui/` | `packages/cli/src/` |
| `src/pi/`, `src/bootstrap/`, `src/config/`, `src/system/`, `src/model/`, `src/search/` | `packages/core/src/` |
| `extensions/` | `packages/extensions/` |
| `prompts/` | `packages/prompts/` |
| `skills/` | unchanged path; referenced via `pi.skills` in `packages/server/package.json` |
| `.feynman/SYSTEM.md`, `.feynman/agents/` | `packages/server/assets/` (image copies on build) |
| `metadata/commands.mjs` | `packages/core/src/manifest.ts` (typed) + a thin adapter for CLI back-compat |

### 9.1 New code (no analogue today)

- `packages/server/src/http.ts` — Fastify or Hono app with the endpoints listed in §5.1.
- `packages/server/src/runner.ts` — spawns Pi in `--mode rpc`, parses NDJSON from stdout, fans out as SSE.
- `packages/server/src/fs-bridge.ts` — server-side of the read/write protocol.
- `packages/server/src/auth.ts` — bearer / Lemon Squeezy middleware (toggle by env).
- `packages/server/Dockerfile` — Node 22 base, copies the workspace, sets `WORKDIR /vault`, exposes 7777.
- `packages/protocol/src/index.ts` — wire types (shared with the plugin repo).
- `modal/feynman_modal.py`, `modal/auth.py` — managed-tier deployment + Lemon Squeezy validation.

### 9.2 Existing code to reuse, not reinvent

- Pi launch + env construction: `src/pi/runtime.ts` (`buildPiArgs`, `buildPiEnv`, `resolvePiPaths`). The server's runner calls these directly.
- First-run asset sync: `src/bootstrap/sync.ts` runs inside the container on boot.
- Optional-tooling resolution: `src/system/executables.ts` for Pandoc, Modal CLI, runpodctl (degrades gracefully when absent).
- Pi extension registration pattern: `extensions/research-tools.ts` — already a clean plugin point; no changes needed.
- Command registry: `metadata/commands.mjs` becomes the single source for `/v1/manifest` so there is no parallel registry to maintain.
- `.feynman/SYSTEM.md` ships unchanged with the image.

## 10. Staged roadmap

Each milestone is independently shippable and testable.

**M0 — Workspace split** *(this repo only)*
Convert to an npm workspace; move files per §9. Keep the `feynman` CLI bit-for-bit identical.
*Verify:* `npm run build` produces the existing CLI; `feynman /deepresearch "…"` behaves as today.

**M1 — `@feynman/server` + Docker image** *(plus Modal-SSE spike, in parallel)*
Implement the `/v1/*` endpoints driving Pi RPC, including the §5.4 reconnect buffer and `Last-Event-ID` replay. Build the multi-arch Docker image. Push to GHCR. **In parallel:** a throwaway spike of "long-lived SSE + bidirectional input pinned to a single Modal container" (§6.3 open risk) — the answer determines whether M5 ships as designed or needs a broker layer in front.
*Verify:* `curl http://localhost:7777/v1/health` returns OK; a `curl`-driven POST to `/v1/run` plus an SSE consumer reproduces a CLI `/deepresearch` run, artifacts written to the mounted vault directory with the expected tree (content is LLM-variable, structure is not). Kill and restart the SSE consumer mid-run with `Last-Event-ID` and confirm zero gaps. Spike succeeds if a single `runId` can hold an SSE stream and receive `POST .../input` on the same Modal instance for >10 min.

**M2 — `feynman-obsidian` plugin (Docker mode only)**
New repo; minimal plugin: settings tab (Docker only), chat view, dynamic command registration from `/v1/manifest`.
*Verify:* install the plugin in a dev vault; every top-level workflow runs end-to-end; artifacts land in `Feynman/`.

**M3 — Self-hosted mode + sandbox artifact pull**
Plugin learns the self-hosted URL mode. Server learns sandbox-mode artifact pull (`GET /v1/runs/:id/artifacts/:path`).
*Verify:* deploy the server to a remote VM, point the plugin at it, run a workflow, artifacts copy into the vault on completion.

**M4 — FS-bridge interactive mode**
Server emits `fs.read_request`/`fs.write_request`; plugin services them. Makes `/lit` workflows that read existing vault notes work in self-host and Modal modes.
*Verify:* run `/lit` against a directory of existing vault notes via the self-hosted server; agent observably reads them mid-run.

**M5 — Managed Modal + Lemon Squeezy**
Deploy `feynman-managed`. Set up the Lemon Squeezy storefront. Implement license activation, validation cache, webhook-driven KV invalidation, and usage caps.
*Verify:* end-to-end purchase → paste license → run a workflow → cap enforcement triggers when exceeded; cancellation propagates within the 6 h cache window.

**M6 — Polish**
Tool-approval modal UX, artifact view, model-picker parity with CLI, usage meter, error surfaces, opt-in auto-update for the Docker image.

## 11. Critical files to author or modify

Paths reflect the post-M0 layout.

- `packages/server/src/http.ts` — endpoints.
- `packages/server/src/runner.ts` — Pi RPC fan-out (consumes `packages/core/src/pi/runtime.ts`).
- `packages/server/src/fs-bridge.ts` — bidirectional fs RPC.
- `packages/server/src/auth.ts` — bearer + Lemon Squeezy middleware.
- `packages/server/Dockerfile` — image build.
- `packages/protocol/src/index.ts` — wire types.
- `packages/core/src/manifest.ts` — replaces `metadata/commands.mjs`.
- `modal/feynman_modal.py`, `modal/auth.py` — managed-tier deployment.
- New repo `feynman-obsidian/` — entire plugin (M2 onward).

## 12. Open questions

These are intentionally deferred; they don't block M0–M2. Resolve as each milestone lands.

1. **Tool-approval policy in Modal mode.** Per-tool approvals are friction the managed-tier user did not pay for. Default to a trusted allowlist (web search, paper fetch, file write to `Feynman/`); let users tighten in settings.
2. **Model billing in Modal mode.** Pay-as-you-go vs. flat-rate. Lean toward flat-rate with hard monthly token caps to keep the value prop legible. Tier design is its own work item.
3. **Docker auto-updates.** Silent vs. opt-in. Recommended: opt-in, with a "new version available" notice; auto-pull on plugin startup if the user enables it.
4. **Multi-vault.** Obsidian users open multiple vaults. The Docker container needs distinct mounts. Namespace the container by vault id (`feynman-server-<vaultId>`) and run one container per vault.
5. **Telemetry.** None for self-host and Docker modes. Modal-tier may need minimal event counts (workflow start, completion) for capacity planning. Opt-in even there.
