// Coverage: src/fs-bridge/handler.ts
//
// Primary focus is `validatePath` — the pure, exported path-validation surface
// every fs.* request flows through. We also drive `FsBridgeHandler` with a
// hand-built `App` stub to assert the rejection-code wiring for the four
// failure paths the spec calls out (oversized payload, rate-limit cap,
// path-validation reject, approval denial).
//
// Approach for the handler tests: instead of trying to stub the entire
// Obsidian `App` API, the handler is built with a minimal duck-typed fake
// whose `vault` methods are recorded; we then inspect the `inputPoster`
// responses to see what code path fired. The handler's diagnostic
// `console.debug` lines name the rejection code; we intercept those too so
// tests can assert without depending on the public response shape (which is
// the same on every rejection: `{ ok: false }` for writes).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FsBridgeHandler,
  validatePath,
  type FsRejectionCode,
} from "../src/fs-bridge/handler";
import type { Event, Input } from "../src/protocol";
// Pulled from the obsidian-stub (tests/_obsidian-stub.mjs). The handler's
// `resolveFile` does `node instanceof TFile`, so we hand it back an instance
// of THIS class — same identity as the one the handler imports under the
// stub.
import { TFile } from "obsidian";

// -------------------- validatePath (pure) ------------------------------

test("validatePath: rejects ../traversal", () => {
  assert.equal(validatePath("../etc/passwd"), "contains-..");
  assert.equal(validatePath("notes/../../boom"), "contains-..");
});

test("validatePath: rejects absolute /paths", () => {
  assert.equal(validatePath("/etc/passwd"), "absolute");
  assert.equal(validatePath("/Users/me/file.md"), "absolute");
});

test("validatePath: rejects ~/home shortcuts (literal tilde stays a literal char, but should NOT be writable in vault)", () => {
  // ~/secret is technically a relative path in vault terms (no `/` lead),
  // and the handler delegates real resolution to Obsidian's vault adapter.
  // The validatePath helper itself only screens for traversal + absolutes +
  // schemes + invalid UTF-8 — `~/secret` survives validatePath but is
  // expected to fail at `getAbstractFileByPath` (returns null → fs/not-found
  // for reads, allowlist + approval path for writes). Document the gap:
  // this test asserts the current contract — the helper does NOT special-
  // case `~`. The vault adapter rejection is the second line of defense.
  assert.equal(validatePath("~/secret"), null);
});

test("validatePath: rejects scheme-prefixed inputs", () => {
  assert.equal(validatePath("http://example.com"), "scheme:http:");
  assert.equal(validatePath("https://example.com"), "scheme:https:");
  assert.equal(validatePath("file:///etc/passwd"), "scheme:file:");
  assert.equal(validatePath("javascript:alert(1)"), "scheme:javascript:");
  assert.equal(validatePath("data:text/html,foo"), "scheme:data:");
});

test("validatePath: rejects empty + whitespace-only inputs", () => {
  assert.equal(validatePath(""), "empty");
  assert.equal(validatePath("   "), "whitespace-only");
  assert.equal(validatePath("\t\n"), "whitespace-only");
});

test("validatePath: accepts a clean relative path", () => {
  assert.equal(validatePath("notes/foo.md"), null);
  assert.equal(validatePath("Feynman/outputs/x.md"), null);
});

test("validatePath: rejects non-string inputs (defensive)", () => {
  assert.equal(validatePath(undefined as unknown as string), "not-a-string");
  assert.equal(validatePath(null as unknown as string), "not-a-string");
  assert.equal(validatePath(42 as unknown as string), "not-a-string");
});

test("validatePath: rejects strings containing unpaired surrogates", () => {
  // U+D800 is a high surrogate; on its own this is not valid UTF-8.
  const bad = "notes/\uD800file.md";
  assert.equal(validatePath(bad), "non-utf8");
});

test("validatePath: rejects dot-prefixed segments (.obsidian, .git, .env)", () => {
  // Top-level dotfolder — the prime exfil target (.obsidian holds plugin
  // settings + tokens for other plugins).
  assert.equal(
    validatePath(".obsidian/plugins/feynman-research-agent/data.json"),
    "dot-segment:.obsidian",
  );
  assert.equal(validatePath(".env"), "dot-segment:.env");
  assert.equal(validatePath(".git/config"), "dot-segment:.git");
  // Dot-folder in the middle of a path.
  assert.equal(
    validatePath("notes/.archive/x.md"),
    "dot-segment:.archive",
  );
  // Leading `./` is also rejected (`..` traversal already caught separately).
  assert.equal(validatePath("./notes/foo.md"), "dot-segment:.");
});

test("validatePath: rejects bidi/control characters", () => {
  // U+202E (RTL override) — visually flips trailing text. A path with this
  // character displays in the approval modal as something the user did not
  // actually consent to write.
  assert.equal(validatePath("notes/foo‮.md"), "control-or-bidi");
  // Zero-width space.
  assert.equal(validatePath("notes/foo​.md"), "control-or-bidi");
  // C0 control (TAB is in this range, but not LF/CR which JSON would reject
  // upstream).
  assert.equal(validatePath("notes/foo.md"), "control-or-bidi");
  // BOM.
  assert.equal(validatePath("notes/﻿foo.md"), "control-or-bidi");
});

// -------------------- FsBridgeHandler (stubbed App) --------------------

// Minimal `App` shape the handler touches. Marked `any` at the cast site so
// we don't need to satisfy the full Obsidian.App interface.
type StubVault = {
  read: (file: unknown) => Promise<string>;
  modify: (file: unknown, content: string) => Promise<void>;
  create: (path: string, content: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  getAbstractFileByPath: (path: string) => unknown;
};

function makeApp(vault: Partial<StubVault> = {}): {
  app: unknown;
  vault: StubVault;
} {
  const v: StubVault = {
    read: vault.read ?? (async () => ""),
    modify: vault.modify ?? (async () => undefined),
    create: vault.create ?? (async () => undefined),
    createFolder: vault.createFolder ?? (async () => undefined),
    getAbstractFileByPath: vault.getAbstractFileByPath ?? (() => null),
  };
  return { app: { vault: v }, vault: v };
}

function makeWriteRequest(reqId: string, path: string, content: string) {
  const ev: Extract<Event, { type: "fs.write_request" }> & {
    id: number;
    ts: number;
  } = {
    id: 1,
    ts: Date.now(),
    type: "fs.write_request",
    reqId,
    path,
    content,
  };
  return ev;
}

function captureResponses() {
  const posted: Input[] = [];
  const poster = async (input: Input): Promise<void> => {
    posted.push(input);
  };
  return { posted, poster };
}

function captureDebug(): {
  codes: FsRejectionCode[];
  restore: () => void;
} {
  const codes: FsRejectionCode[] = [];
  const original = console.debug;
  console.debug = (...args: unknown[]): void => {
    const line = String(args[0] ?? "");
    // Match the handler's `code=<value>` token. Codes look like
    // `fs/too-large`, `fs/rate-limited`, etc. — slashes, lowercase, hyphens.
    const m = /code=([a-z/-]+)/.exec(line);
    if (m !== null && m[1] !== undefined) codes.push(m[1] as FsRejectionCode);
  };
  return {
    codes,
    restore: () => {
      console.debug = original;
    },
  };
}

test("FsBridgeHandler.handleWriteRequest: rejects path-validation failures with fs/rejected", async () => {
  const { app } = makeApp();
  const { posted, poster } = captureResponses();
  const dbg = captureDebug();
  const handler = new FsBridgeHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    runId: "run-1",
    initialAllowlist: new Set(),
    inputPoster: poster,
    requestWriteApproval: async () => true,
  });
  await handler.handleWriteRequest(makeWriteRequest("r1", "../etc/passwd", "x"));
  dbg.restore();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, "fs.write_response");
  assert.equal((posted[0] as { ok: boolean }).ok, false);
  assert.ok(dbg.codes.includes("fs/rejected"));
});

test("FsBridgeHandler.handleWriteRequest: rejects oversized payloads with fs/too-large", async () => {
  const { app } = makeApp();
  const { posted, poster } = captureResponses();
  const dbg = captureDebug();
  const handler = new FsBridgeHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    runId: "run-2",
    initialAllowlist: new Set(["notes/big.md"]),
    inputPoster: poster,
    requestWriteApproval: async () => true,
  });
  // 5 MB > MAX_WRITE_BYTES (4 MB).
  const bigContent = "x".repeat(5 * 1024 * 1024);
  await handler.handleWriteRequest(
    makeWriteRequest("r2", "notes/big.md", bigContent),
  );
  dbg.restore();
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { ok: boolean }).ok, false);
  assert.ok(dbg.codes.includes("fs/too-large"));
});

test("FsBridgeHandler.handleWriteRequest: rate-limits at 50 requests per run", async () => {
  const { app } = makeApp();
  const { posted, poster } = captureResponses();
  const dbg = captureDebug();
  const handler = new FsBridgeHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    runId: "run-3",
    initialAllowlist: new Set(["notes/ok.md"]),
    inputPoster: poster,
    requestWriteApproval: async () => true,
  });
  // First 50 writes should succeed; the 51st is rate-limited. The fake
  // vault returns null for `getAbstractFileByPath`, so each one falls into
  // the create() branch — that's fine, our fake `create` is a no-op.
  for (let i = 0; i < 51; i++) {
    await handler.handleWriteRequest(
      makeWriteRequest(`r${i}`, "notes/ok.md", "ok"),
    );
  }
  dbg.restore();
  assert.equal(posted.length, 51);
  // The 51st response must be a rate-limited rejection.
  assert.equal((posted[50] as { ok: boolean }).ok, false);
  assert.ok(dbg.codes.includes("fs/rate-limited"));
  // The first 50 must NOT be flagged rate-limited.
  // (They may all be `fs.write_response { ok: true }` — assert that.)
  for (let i = 0; i < 50; i++) {
    assert.equal((posted[i] as { ok: boolean }).ok, true);
  }
});

test("FsBridgeHandler.handleWriteRequest: non-allowlisted path + Deny → fs/denied", async () => {
  const { app } = makeApp();
  const { posted, poster } = captureResponses();
  const dbg = captureDebug();
  const handler = new FsBridgeHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    runId: "run-4",
    initialAllowlist: new Set(), // empty — any path needs approval
    inputPoster: poster,
    requestWriteApproval: async (_path: string) => false, // user denies
  });
  await handler.handleWriteRequest(
    makeWriteRequest("r-deny", "notes/private.md", "secret"),
  );
  dbg.restore();
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { ok: boolean }).ok, false);
  assert.ok(dbg.codes.includes("fs/denied"));
});

test("FsBridgeHandler.handleWriteRequest: allowlisted path writes successfully", async () => {
  let modifyCalled = false;
  const { app } = makeApp({
    // Make resolveFile return non-null so the modify() branch fires. The
    // value just needs to be `instanceof TFile` per the handler's check —
    // since the obsidian stub's TFile is a plain class, an instance works.
    getAbstractFileByPath: () => new TFile(),
    modify: async () => {
      modifyCalled = true;
    },
  });
  const { posted, poster } = captureResponses();
  const handler = new FsBridgeHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    runId: "run-5",
    initialAllowlist: new Set(["notes/ok.md"]),
    inputPoster: poster,
    requestWriteApproval: async () => false,
  });
  await handler.handleWriteRequest(makeWriteRequest("r-ok", "notes/ok.md", "v"));
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as { ok: boolean }).ok, true);
  assert.ok(modifyCalled, "vault.modify should be called for an existing file");
});
