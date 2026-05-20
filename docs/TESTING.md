# Feynman v1 — Testing & verification

Walks through the §10 M0–M2 verify criteria plus the §5.4 reconnect contract, §8.1 context flow, and the FIX-M1.9/M2.1/M2.2/M1.4 regression checks from Review 2.

Assumes you've completed `docs/SETUP.md`: workspace installed, Docker image built, plugin symlinked into a test vault, container running (or ready to start).

Run sections in order or independently — each is self-contained.

## M0 — Workspace integrity

```bash
cd ~/projects/obsidian-plugins/feynman
npm install
npm run typecheck --workspaces
npm test
node packages/cli/bin/feynman.js --help
```

**Pass:** all 5 packages typecheck; ≥172 tests green; CLI prints help banner with workflows listed (deepresearch, lit, audit, replicate, recipe, review, compare, draft, autoresearch, watch, summarize, log, jobs).

If anything fails: M0 has regressed. Don't proceed.

## M1 — Server endpoints

Start the server in dev mode (no Docker required for this check):

```bash
cd ~/projects/obsidian-plugins/feynman
FEYNMAN_VAULT=/tmp/feynman-test FEYNMAN_AUTH_TOKEN=devtoken \
  npm run dev -w @feynman/server
```

(Make `/tmp/feynman-test` if it doesn't exist: `mkdir -p /tmp/feynman-test`.)

In another terminal:

```bash
H='Authorization: Bearer devtoken'

# 1. Health
curl -s http://127.0.0.1:7777/v1/health
# expect: {"ok":true,"version":"0.0.0"}

# 2. Manifest
curl -s http://127.0.0.1:7777/v1/manifest -H "$H" | jq '.prompts | map(.slug)'
# expect: ["deepresearch","lit","audit","replicate","recipe","review","compare","draft","autoresearch","watch",...]

curl -s http://127.0.0.1:7777/v1/manifest -H "$H" | jq '.capabilities'
# expect: {"vaultModes":["docker"],"fsBridge":false,"artifactPull":true}

# 3. Start a run
runId=$(curl -s -X POST http://127.0.0.1:7777/v1/run -H "$H" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"deepresearch","args":{"topic":"transformer attention"},"vaultMode":"docker"}' \
  | jq -r '.runId')
echo "runId: $runId"

# 4. Stream events (Ctrl-C when you have enough)
curl -N "http://127.0.0.1:7777/v1/runs/$runId/events" -H "$H"
# expect: alternating `id: N` and `data: {...}` lines, with `:keepalive` every ~10s

# 5. Inspect artifacts on disk
ls /tmp/feynman-test/Feynman/outputs/ 2>/dev/null
```

**Pass:** every step returns the expected shape. SSE ids are monotonically increasing; at least one `agent.message` or `agent.thinking` event reaches the client; artifacts appear under `Feynman/outputs/`.

**Fail signals:**
- `/v1/manifest` returns empty `prompts: []` → manifest builder is broken (likely FIX-M1.5 regressed `context:` parsing crashed on a real prompt; check server logs).
- SSE has no `id:` line per frame → §5.4 ordering broken.
- No `:keepalive` arrives → idle-timeout protection lost; reconnects through proxies will fail.

## §5.4 — Reconnect contract

While a run is **mid-stream** (don't wait for completion):

```bash
# Capture some events, then ^C partway
curl -N "http://127.0.0.1:7777/v1/runs/$runId/events" -H "$H" | head -20
# Note the highest `id:` you saw — call it N

# Reconnect with Last-Event-ID
curl -N "http://127.0.0.1:7777/v1/runs/$runId/events" \
  -H "$H" -H "Last-Event-ID: $N"
# expect: only events with id > N, then live stream
```

**Pass:** the second curl shows no events with id ≤ N. No gap, no duplication.

**Partial-window eviction (FIX-M1.4):** start a long run (1000+ events), reconnect with `Last-Event-ID: 1` after the buffer has trimmed:

```bash
curl -i "http://127.0.0.1:7777/v1/runs/$runId/events" \
  -H "$H" -H "Last-Event-ID: 1"
# expect: HTTP 409 Gone (not a silent partial replay)
```

**Post-grace eviction:** wait for run.done + 5 min, then reconnect:

```bash
curl -i "http://127.0.0.1:7777/v1/runs/$runId/events" \
  -H "$H" -H "Last-Event-ID: 1"
# expect: HTTP 409 Gone
```

## M2 — Plugin end-to-end (Obsidian-side)

Container running (per `docs/SETUP.md` step 5). In Obsidian:

1. Cmd-P → **Feynman: Server status** → Notice with `ok=true version=... prompts=N`. **Pass.**
2. Cmd-P → **Feynman: Open chat** → an empty chat pane opens on the right. **Pass.**
3. Cmd-P → **Feynman: Deep research…** → input modal renders the `topic` field (and any other declared args). Submit something simple ("a brief summary of the transformer paper"). The chat pane shows:
   - thinking blocks streaming as `<pre>` (plain text, no markdown formatting).
   - When a message closes (or 250 ms after the last delta), the block re-renders through `MarkdownRenderer` — code fences highlight, links activate, embeds resolve. **Pass.**
4. After `run.done` arrives, look in the vault: `Feynman/outputs/` has a fresh markdown file. Click the artifact link in the chat view → the file opens in Obsidian. **Pass.**

## §8.1 — Active-note context (requires FIX-M1.5/M1.6 landed)

Confirm the protocol round-trip:

1. Open a paper note (any markdown file with substantive content) in the vault.
2. Select a paragraph.
3. Cmd-P → **Feynman: Review this paper…** (this command appears only if `packages/prompts/review.md` declares `context: [activeFile, selection]` in its frontmatter; M1.5 should have added that).
4. Watch the chat view — the review's content should explicitly reference the file or the selection (e.g. "The paragraph you selected argues that...").

**Pass:** the review reflects the actual note content. The plugin captured `activeFile` + `selection`, posted them in `RunRequest.context`, and the server materialised them into the Pi prompt.

**Fail:** if the review is generic and ignores the file → FIX-M1.5 or FIX-M1.6 didn't fully land. Check the server logs for `[run <id>] context tokens received: ...`. If absent, the runner isn't reading `req.context`.

**Token-rejection check (§5.5 invariant):** with curl, send a context token the manifest doesn't declare:

```bash
curl -s -X POST http://127.0.0.1:7777/v1/run -H "$H" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"deepresearch","args":{"topic":"x"},"vaultMode":"docker","context":{"openTabs":[{"path":"foo.md"}]}}'
# expect: HTTP 400 with a clear message — deepresearch doesn't opt into openTabs
```

## SSE iterator terminus (FIX-M2.1/M2.2 regression check)

In Obsidian:

1. Cmd-Opt-I → Network tab → filter for "events".
2. Run a small workflow (e.g. `summarize` or a short `deepresearch`).
3. Wait for `run.done` to arrive in the chat view.
4. **Pass:** no further requests to `/v1/runs/.../events` after the terminal event. Stream closes cleanly.

If you see repeated reconnect attempts (one per back-off interval, then 409s after 5 min), M2.1 regressed.

## Tool-approval modal label (FIX-M1.9 regression check)

Trigger any workflow that fires a Pi `extension_ui_request method=confirm` (most common: a workflow that wants to install a missing skill or write to an unusual path). When the modal opens:

**Pass:** the heading shows the confirmation prompt (e.g. "Install missing skill `paper-fetch`?") — NOT "Tool: <something nonsensical>".

The modal subtitle reads "Request ID: ..." (not "Tool ID: ...").

## What v1 does NOT support (yet)

- Self-hosted sandbox/FS-bridge modes (M3/M4).
- Managed Modal (M5).
- Docker auto-supervisor — manual `docker run` is the workaround.
- §7.1 vault staging — Pi writes directly to vault during streaming. Disable vault sync during long runs.
- Model picker in settings — `manifest.models[]` is empty pending the auth.json story (M5).
- Artifact view tree — exists as a stub, not wired (M6 polish).
- License activation — `/v1/license/activate` returns 501.

## Reporting issues

When something fails, capture:

1. The failing step (e.g. "M1 step 4 — SSE stream had no `id:` lines").
2. Server logs (the dev-mode terminal output or `docker logs feynman-server-test`).
3. Plugin console (Cmd-Opt-I → Console).
4. A minimal repro `curl` invocation if applicable.

File against `feynman-obsidian` if the failure is plugin-side; against `feynman` if server- or workspace-side. The boundary is the wire — anything inside the SSE stream or the JSON response shape is a server bug; anything in the chat view, settings UI, or command palette is plugin.

## Manual verification checklist (Agent 7)

Run these by hand before tagging a v1 release. Each item maps back to one of the five release-review reports in `.pm/release-review/`. The automated `npm test` + `npm run build` + `npx tsc --noEmit` gates the build pipeline; this checklist gates the release decision.

### Distribution / build

- [ ] `git clone <repo>` into a tmp directory (no sibling `feynman/` repo present), `cd` in, `npm install`, `npm run build` → exits 0.
- [ ] `npm test` → exits 0; all tests pass.
- [ ] `npx tsc --noEmit` → exits 0.
- [ ] `cat package.json | jq '.dependencies'` shows no `file:` entries.
- [ ] `cat package.json | jq '.devDependencies'` shows no `"latest"` versions.
- [ ] `manifest.json` version, `package.json` version, and `versions.json` are aligned at `1.0.0`.
- [ ] `LICENSE` exists; `README.md` is more than one sentence and includes Install / Privacy / Anthropic-key-disclosure sections.

### Docker bring-up

- [ ] Fresh vault, fresh Obsidian install. Enable plugin. Settings opens to onboarding. Click "Set up Docker" → plugin actually `pull`s + `start`s; Notices show progress; container shows running in the settings UI.
- [ ] Stop Docker Desktop. Reload plugin. Settings UI shows "Docker daemon not running" (not a stack trace).
- [ ] `docker run -d --name feynman-server -p 7777:7777 …` already running from a prior session. Click "Set up Docker" → supervisor reuses or `--rm`s the stale container, doesn't error on "name in use".
- [ ] Port 7777 occupied by another process. Supervisor auto-bumps to a free port or surfaces a clear error.
- [ ] No Anthropic key visible in `ps aux | grep ANTHROPIC` or `~/.zsh_history` after setup.

### Security

- [ ] `curl -i http://127.0.0.1:7777/v1/health` from another shell **without** the bearer → returns 401.
- [ ] `curl -i -H "Authorization: Bearer <plugin-token>" http://127.0.0.1:7777/v1/health` → returns 200.
- [ ] Trigger a `tool.approval_required` from a test workflow. Modal shows the actual tool name + args; Deny is default-focused; Escape dismisses as Deny.
- [ ] Self-hosted backend: try to save `http://example.com` → rejected inline. `https://example.com` accepted.
- [ ] Modal-tier dropdown option is disabled and shows "(coming soon)".
- [ ] Switch to Self-hosted mode, paste a token, refresh — `data.json` on disk shows the token in plaintext. Settings UI shows the disclosure copy. README has the disclosure.
- [ ] Send an `artifact.written` event from a stub server with `ev.path = "../../../etc/passwd"` → rejected, no link rendered. Same for `javascript:` schemes.

### Transport

- [ ] Run a workflow. Stop Docker mid-stream. Chat view shows a `stream-error` callout within ~30 s (read-watchdog fires, then synthetic error after reconnect threshold). Spinner does not hang forever.
- [ ] Run a workflow. Disable the plugin mid-stream. Server logs show `POST /v1/runs/<id>/cancel` landed. Tokens stop burning.
- [ ] Server returns 401 on the SSE GET. Chat view shows `auth-failed` error callout, not an infinite reconnect loop.
- [ ] Forge a clock-skew: kill the server, wait, restart with the same `runId`. Reopening the chat resumes from `Last-Event-ID`; no event replay.

### fs-bridge

- [ ] Server emits an `fs.read_request` for a vault file. Handler responds via `inputPoster`; run completes.
- [ ] Server emits an `fs.read_request` for `../../etc/passwd`. Handler responds with `{ ok: false, code: "fs/rejected" }`. Run continues.
- [ ] Server emits an `fs.write_request` for a file not in the manifest's declared paths. Approval modal fires; on Deny, server gets `{ ok: false, code: "fs/denied" }`.
- [ ] Server emits an `fs.write_request` with 100 MB content. Handler rejects with `{ ok: false, code: "fs/too-large" }`.

### Obsidian-frontend

- [ ] Plugin survives `Cmd-R` (reload) without leaked listeners (Obsidian dev-tools shows no zombie timers).
- [ ] Switch backend in the dropdown → workflows pane updates label automatically, no manual "Test connection" needed.
- [ ] Type an Anthropic key 60 chars long → `data.json` modtime advances at most twice (debounce holds).
- [ ] Open command palette → commands show without the `Feynman: ` prefix, without trailing ellipsis.
- [ ] No empty `FeynmanArtifactView` pane is exposed anywhere in the UI.
- [ ] Waitlist button: until the real `waitlist_id` is set, the button is gated behind `features.waitlist.enabled = false` and not visible in the default config.
