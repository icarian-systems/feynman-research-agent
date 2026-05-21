// FS-bridge handler — services `fs.read_request` and `fs.write_request`
// events from the server (ARCHITECTURE.md §5.2, §6.2/§6.3).
//
// The on-wire reply uses the protocol's `Input` shapes:
//   - `fs.read_response { reqId, content: string | null }`
//   - `fs.write_response { reqId, ok: boolean }`
//
// The rejection grammar (`fs/rejected`, `fs/too-large`, `fs/rate-limited`,
// `fs/denied`, `fs/not-found`, `fs/vault-unmounted`, `fs/internal`) is
// surfaced via console diagnostics so dev / tests can see why a request was
// rejected. Read rejections collapse to `content: null`; write rejections
// collapse to `ok: false`. See docs/FS-BRIDGE-SPEC.md for the full
// rationale and threat model.
//
// Lifecycle: one handler per run. The chat view instantiates it when a run
// is attached and calls `teardown()` from `onClose`. After teardown, the
// handler short-circuits every request with `fs/vault-unmounted`.
//
// This file deliberately does not `throw` from the public methods — every
// failure path responds via `inputPoster` and resolves. (A throw would leave
// the server waiting on an `fs.*_response` that never arrives, hanging the
// run.)

import type { App, TFile } from "obsidian";
import { TFile as ObsidianTFile } from "obsidian";
import type { Event, Input } from "../protocol";

// -----------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------

export interface FsBridgeOptions {
  app: App;
  runId: string;
  /** Allowlist of vault-relative paths writable without approval. */
  initialAllowlist: ReadonlySet<string>;
  /** Posts an Input back to the server. Wired by chat-view. */
  inputPoster: (input: Input) => Promise<void>;
  /**
   * Invoked when a write to a non-allowlisted path needs user approval.
   * Returns `true` on Allow (the path is added to the allowlist by the
   * handler), `false` on Deny. The chat view bridges this to Agent 4's
   * redesigned `ToolApprovalModal`.
   */
  requestWriteApproval: (path: string) => Promise<boolean>;
}

/** Internal rejection codes — surface in diagnostics + tests. */
export type FsRejectionCode =
  | "fs/rejected"
  | "fs/too-large"
  | "fs/rate-limited"
  | "fs/denied"
  | "fs/not-found"
  | "fs/vault-unmounted"
  | "fs/internal";

type FsReadRequest = Extract<Event, { type: "fs.read_request" }>;
type FsWriteRequest = Extract<Event, { type: "fs.write_request" }>;

// -----------------------------------------------------------------------
// Limits (per spec)
// -----------------------------------------------------------------------

const MAX_WRITE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_READ_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_REQUESTS_PER_RUN = 50;

const REJECTED_SCHEMES = ["http:", "https:", "file:", "javascript:", "data:"] as const;

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------

export class FsBridgeHandler {
  private readonly app: App;
  // Held for diagnostics + future per-run state keyed off the run id.
  readonly runId: string;
  private readonly allowlist: Set<string>;
  private readonly inputPoster: (input: Input) => Promise<void>;
  private readonly requestWriteApproval: (path: string) => Promise<boolean>;

  /** Counter saturates at MAX_REQUESTS_PER_RUN + 1. */
  private requestCount = 0;
  /** Pending reqIds, drained by teardown(). */
  private readonly pending: Set<string> = new Set();
  private tornDown = false;

  constructor(opts: FsBridgeOptions) {
    this.app = opts.app;
    this.runId = opts.runId;
    this.allowlist = new Set(opts.initialAllowlist);
    this.inputPoster = opts.inputPoster;
    this.requestWriteApproval = opts.requestWriteApproval;
  }

  /** Handle an `fs.read_request` event from the server. */
  async handleReadRequest(ev: FsReadRequest): Promise<void> {
    if (this.tornDown) {
      await this.replyReadRejected(ev.reqId, "fs/vault-unmounted");
      return;
    }
    this.pending.add(ev.reqId);
    try {
      if (this.exceedsRateLimit()) {
        await this.replyReadRejected(ev.reqId, "fs/rate-limited");
        return;
      }
      const pathError = validatePath(ev.path);
      if (pathError !== null) {
        await this.replyReadRejected(ev.reqId, "fs/rejected", pathError);
        return;
      }
      const file = this.resolveFile(ev.path);
      if (file === null) {
        await this.replyReadRejected(ev.reqId, "fs/not-found");
        return;
      }
      // Pre-flight size check via stat so we can reject oversized reads
      // without loading the bytes.
      const statSize = file.stat?.size;
      if (typeof statSize === "number" && statSize > MAX_READ_BYTES) {
        await this.replyReadRejected(ev.reqId, "fs/too-large");
        return;
      }
      let content: string;
      try {
        content = await this.app.vault.read(file);
      } catch (err) {
        this.logCode(ev.reqId, "fs/internal", String(err));
        await this.replyReadRejected(ev.reqId, "fs/internal");
        return;
      }
      // Belt + suspenders: re-check post-read in case stat was unavailable
      // (e.g. some mobile adapters) or the file mutated between stat + read.
      const byteLen = utf8ByteLength(content);
      if (byteLen > MAX_READ_BYTES) {
        await this.replyReadRejected(ev.reqId, "fs/too-large");
        return;
      }
      await this.safePost({
        type: "fs.read_response",
        reqId: ev.reqId,
        content,
      });
    } finally {
      this.pending.delete(ev.reqId);
    }
  }

  /** Handle an `fs.write_request` event from the server. */
  async handleWriteRequest(ev: FsWriteRequest): Promise<void> {
    if (this.tornDown) {
      await this.replyWriteRejected(ev.reqId, "fs/vault-unmounted");
      return;
    }
    this.pending.add(ev.reqId);
    try {
      if (this.exceedsRateLimit()) {
        await this.replyWriteRejected(ev.reqId, "fs/rate-limited");
        return;
      }
      const pathError = validatePath(ev.path);
      if (pathError !== null) {
        await this.replyWriteRejected(ev.reqId, "fs/rejected", pathError);
        return;
      }
      const byteLen = utf8ByteLength(ev.content);
      if (byteLen > MAX_WRITE_BYTES) {
        await this.replyWriteRejected(ev.reqId, "fs/too-large");
        return;
      }
      if (!this.allowlist.has(ev.path)) {
        let allowed: boolean;
        try {
          allowed = await this.requestWriteApproval(ev.path);
        } catch (err) {
          this.logCode(ev.reqId, "fs/internal", String(err));
          await this.replyWriteRejected(ev.reqId, "fs/internal");
          return;
        }
        if (!allowed) {
          await this.replyWriteRejected(ev.reqId, "fs/denied");
          return;
        }
        this.allowlist.add(ev.path);
      }
      // Perform the write. Existing file → modify; missing file → create
      // (after ensuring the parent folder exists).
      try {
        const existing = this.resolveFile(ev.path);
        if (existing !== null) {
          await this.app.vault.modify(existing, ev.content);
        } else {
          await this.ensureParentFolder(ev.path);
          await this.app.vault.create(ev.path, ev.content);
        }
      } catch (err) {
        this.logCode(ev.reqId, "fs/internal", String(err));
        await this.replyWriteRejected(ev.reqId, "fs/internal");
        return;
      }
      await this.safePost({
        type: "fs.write_response",
        reqId: ev.reqId,
        ok: true,
      });
    } finally {
      this.pending.delete(ev.reqId);
    }
  }

  /**
   * Drain pending requests with `fs/vault-unmounted` and mark the handler
   * dead. Idempotent.
   */
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    const pending = Array.from(this.pending);
    this.pending.clear();
    if (pending.length === 0) return;
    // Best-effort drain. We don't know which were reads vs. writes from the
    // reqId alone, so emit a write-shaped rejection (the more conservative —
    // `ok: false` is unambiguous) followed by a read-shaped one. The server
    // dedupes on reqId per §5.4, so the second arrival is a no-op once it
    // has the first.
    await Promise.allSettled(
      pending.flatMap((reqId) => [
        this.safePost({
          type: "fs.read_response",
          reqId,
          content: null,
        }),
        this.safePost({
          type: "fs.write_response",
          reqId,
          ok: false,
        }),
      ]),
    );
    for (const reqId of pending) {
      this.logCode(reqId, "fs/vault-unmounted");
    }
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  /**
   * Increments the per-run request counter and returns true if the current
   * request should be rejected as over-quota. Saturates so subsequent
   * requests don't keep adding cost.
   */
  private exceedsRateLimit(): boolean {
    if (this.requestCount >= MAX_REQUESTS_PER_RUN) {
      // Saturate but do not increment past the cap; the counter signals
      // "rate-limited from here on".
      return true;
    }
    this.requestCount += 1;
    return false;
  }

  private resolveFile(path: string): TFile | null {
    const node = this.app.vault.getAbstractFileByPath(path);
    if (node instanceof ObsidianTFile) return node;
    return null;
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return; // top-level file in the vault
    const parent = path.slice(0, slash);
    const existing = this.app.vault.getAbstractFileByPath(parent);
    if (existing !== null) return;
    await this.app.vault.createFolder(parent);
  }

  private async replyReadRejected(
    reqId: string,
    code: FsRejectionCode,
    reason?: string,
  ): Promise<void> {
    this.logCode(reqId, code, reason);
    await this.safePost({
      type: "fs.read_response",
      reqId,
      content: null,
    });
  }

  private async replyWriteRejected(
    reqId: string,
    code: FsRejectionCode,
    reason?: string,
  ): Promise<void> {
    this.logCode(reqId, code, reason);
    await this.safePost({
      type: "fs.write_response",
      reqId,
      ok: false,
    });
  }

  /** Post an Input; swallow + log errors so teardown / loops keep going. */
  private async safePost(input: Input): Promise<void> {
    try {
      await this.inputPoster(input);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[feynman fs-bridge] post failed for run ${this.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private logCode(
    reqId: string,
    code: FsRejectionCode,
    reason?: string,
  ): void {
    // eslint-disable-next-line no-console
    console.debug(
      `[feynman fs-bridge] run=${this.runId} req=${reqId} code=${code}${
        reason !== undefined ? ` reason=${reason}` : ""
      }`,
    );
  }
}

// -----------------------------------------------------------------------
// Path validation (pure)
// -----------------------------------------------------------------------

// C0/C1 control chars and Unicode bidi formatting characters. A path
// containing any of these can be displayed in the approval modal in a
// way that doesn't match what's actually written (RTL override, zero-width
// space, etc.). Rejecting at the validator means the user never sees a
// deceptive path in the prompt.
// Built via RegExp() so the source stays free of literal control characters
// (the alternative — a regex literal — embeds the bytes verbatim, which
// breaks copy/paste review and editor tooling).
const DISALLOWED_CHARS = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]"
);

/**
 * Validate a vault-relative path. Returns `null` on success, or a short
 * machine-readable reason string on rejection (suitable for logging).
 */
export function validatePath(path: string): string | null {
  if (typeof path !== "string") return "not-a-string";
  if (path.length === 0) return "empty";
  if (path.trim().length === 0) return "whitespace-only";
  if (path.includes("..")) return "contains-..";
  if (path.startsWith("/")) return "absolute";
  for (const scheme of REJECTED_SCHEMES) {
    if (path.startsWith(scheme)) return `scheme:${scheme}`;
  }
  if (DISALLOWED_CHARS.test(path)) return "control-or-bidi";
  // Reject any path component starting with `.` (e.g. `.obsidian/...`,
  // `.git/...`, `.env`). The plugin's own settings, OAuth state for other
  // plugins, and OS-level config files all live under dot-prefixed
  // directories; the agent never has a legitimate reason to touch them.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg.length > 0 && seg.startsWith(".")) return `dot-segment:${seg}`;
  }
  if (!isUtf8Roundtrip(path)) return "non-utf8";
  return null;
}

/**
 * Round-trip the string through UTF-8 encode + decode and compare. Catches
 * unpaired surrogates and other ill-formed sequences that would otherwise
 * survive as JS strings.
 */
function isUtf8Roundtrip(s: string): boolean {
  try {
    const encoded = new TextEncoder().encode(s);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded);
    return decoded === s;
  } catch {
    return false;
  }
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}
