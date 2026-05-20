# fs-bridge Spec (v1)

## Purpose

The server emits `fs.read_request` / `fs.write_request` events when running
agents need to read or write vault files on the user's behalf (ARCHITECTURE.md
§5.2, §6.2/§6.3). The plugin's fs-bridge handler validates each request,
applies the rules below, and posts back an `fs.read_response` /
`fs.write_response` `Input` via the chat view's input poster.

The plugin treats the server as semi-trusted: it implements the wire contract
the plugin asked for, but a compromised or misbehaving server could attempt
path traversal, oversized payloads, or rapid-fire amplification. The rules
below mitigate each.

## Path validation

A request path is **rejected before any vault I/O** if any of the following
hold:

- Contains `..` anywhere (literal substring).
- Starts with `/` (absolute / vault-rooted).
- Contains a non-UTF-8 byte (treat the path as a JS string — if it round-trips
  through `TextEncoder` → `TextDecoder` and the decoded string differs, it
  contained an invalid sequence).
- Starts with a URL scheme: `http:`, `https:`, `file:`, `javascript:`,
  `data:`.
- Empty string or whitespace-only.

Resolution: paths are interpreted relative to the Obsidian vault root and
resolved via `app.vault.getAbstractFileByPath(path)`. The plugin does **not**
use OS-level absolute paths and does not follow OS symlinks. Obsidian's vault
adapter abstracts the filesystem; symlinks outside the vault are not exposed
via the vault API in the default `FileSystemAdapter` configuration, so the
spec relies on the adapter's safety boundary rather than a separate
`O_NOFOLLOW` check.

If a write target's parent folder does not exist, the handler attempts to
create it via `app.vault.createFolder(parentPath)` before the write. Folder
creation failure surfaces as `fs/internal` — the path was syntactically valid
but the adapter rejected the create.

## Limits

- Per-request **write** payload: ≤ 4 MB (UTF-8 byte length of `content`,
  measured via `TextEncoder().encode(content).byteLength`).
- Per-request **read** payload: ≤ 8 MB. The file is `stat`ed via
  `TFile.stat.size` first; if it exceeds the cap, the handler rejects without
  reading. Files whose size is unknown ahead of read get post-read byte-length
  check as a fallback.
- Per-run **rate limit**: 50 fs requests total across read + write. The 51st
  returns `{ ok: false, code: "fs/rate-limited" }` and is not counted further
  (the counter saturates).

## Allowlist + approval

- The handler maintains a per-run write allowlist seeded at construction time
  from `initialAllowlist` (the chat view passes paths declared by the
  manifest / run config; until protocol surfaces such a field the allowlist
  starts empty).
- A **read** request to any path is allowed (subject to validation, size
  cap, and rate limit). Reads do not consume an approval.
- A **write** request to a path **on** the allowlist proceeds immediately.
- A **write** request to a path **not** on the allowlist triggers the
  redesigned `ToolApprovalModal` flow via the chat-view seam
  (`requestWriteApproval(path) → Promise<boolean>`). On Allow: the path is
  added to the run's allowlist for the remainder of the run; the write
  proceeds. On Deny: respond `{ ok: false, code: "fs/denied" }`.

## Response codes

The wire-level `Input` shapes are fixed: `fs.read_response` carries
`content: string | null`; `fs.write_response` carries `ok: boolean`. The
extended `{ ok: false, code, reason? }` payload described in the original
threat model is therefore not transmitted to the server in v1 — instead the
plugin emits these structured rejection records to the dev console for
auditability, and the on-wire reply collapses to:

- Read rejection: `{ type: "fs.read_response", reqId, content: null }`.
- Write rejection: `{ type: "fs.write_response", reqId, ok: false }`.

Internal rejection codes used in logs (and surfaced to tests via the spec
gate):

- `fs/rejected` — path failed validation.
- `fs/too-large` — payload exceeded the size cap.
- `fs/rate-limited` — per-run rate cap hit.
- `fs/denied` — approval modal was denied.
- `fs/not-found` — file does not exist (read only).
- `fs/vault-unmounted` — vault unloaded mid-request.
- `fs/internal` — unexpected error during read / write / folder create.

A future protocol revision is expected to extend the `Input` shapes so the
server can distinguish a deny vs. an oversized write vs. a 4xx-style
rejection; the handler's internal code path is already partitioned so that
revision is a wire-format change, not a control-flow change.

## Vault unload behavior

If the run is in-flight and the user disables the plugin / closes the vault
mid-request, the handler responds with the empty-rejection shape (read:
`content: null`; write: `ok: false`) for every pending request before
tearing down. The corresponding internal code is `fs/vault-unmounted`.

After `teardown()` resolves, subsequent `handleReadRequest` /
`handleWriteRequest` calls short-circuit to the same `fs/vault-unmounted`
rejection — the handler is single-use per run.

## Threat model (one paragraph)

The plugin trusts the server to behave reasonably but does not trust it not
to be compromised. A compromised server could craft path-traversal requests,
oversized writes, or rapid-fire requests aimed at saturating the bridge.
The validation rules above mitigate each: traversal is rejected outright
before any path resolution; oversized payloads are rejected before any vault
I/O so a 1 GB write costs the plugin only a `TextEncoder.encode().byteLength`
call (which already streams in V8); rate-limit caps per-run amplification at
50; write approval gates novel filesystem destinations behind explicit user
consent via the redesigned `ToolApprovalModal` (default-deny focus from
Agent 4's redesign). Out of scope: malicious **content** of agent-authored
files (the user is expected to review what an agent writes — that's what the
diff UI is for) and OS-keychain integration for the bearer token (deferred
to v1.1).
