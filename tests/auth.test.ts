// Coverage: src/transport/auth.ts — header builders for the transport client.
//
// `bearerHeaders(token)` returns `{ Authorization: "Bearer <token>" }` when
// `token` is a non-empty string, else `{}`. The plugin-side back-ends (Docker,
// self-hosted, Modal) just choose which token to pass; the function itself is
// backend-agnostic. We exercise each case the plugin actually uses.
//
// `clientHeaders(version)` always returns the X-Feynman-Client header.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bearerHeaders, clientHeaders } from "../src/transport/auth";

test("bearerHeaders: docker mode with a token", () => {
  // Docker mode generates a random bearer at container start (Agent 4).
  // The transport client reads it via `getAuth()` and passes the value here.
  const h = bearerHeaders("local-docker-token-abc");
  assert.deepEqual(h, { Authorization: "Bearer local-docker-token-abc" });
});

test("bearerHeaders: self-hosted with a user-provided token", () => {
  const h = bearerHeaders("user-self-hosted-secret");
  assert.deepEqual(h, { Authorization: "Bearer user-self-hosted-secret" });
});

test("bearerHeaders: Modal mode (disabled in v1) returns no Authorization", () => {
  // Agent 4 disabled Modal in the settings dropdown; `resolveAuth` returns
  // null in that branch. Null tokens must NOT add an Authorization header.
  const h = bearerHeaders(null);
  assert.deepEqual(h, {});
  // Spreadable into a header bag without polluting it.
  const merged = { Accept: "application/json", ...h };
  assert.deepEqual(merged, { Accept: "application/json" });
});

test("bearerHeaders: empty string is treated the same as null", () => {
  const h = bearerHeaders("");
  assert.deepEqual(h, {});
});

test("clientHeaders builds the X-Feynman-Client header from manifest version", () => {
  const h = clientHeaders("1.0.0");
  assert.deepEqual(h, { "X-Feynman-Client": "obsidian-plugin/1.0.0" });
});

test("clientHeaders preserves arbitrary version strings verbatim", () => {
  // Pre-release / dev builds may carry suffixes; the server uses this for
  // telemetry, not parsing, so we should pass it through unchanged.
  const h = clientHeaders("1.0.0-rc.2");
  assert.equal(h["X-Feynman-Client"], "obsidian-plugin/1.0.0-rc.2");
});

test("merging bearerHeaders + clientHeaders yields the expected request bag", () => {
  // Mirrors how `FeynmanClient#headers` composes them.
  const merged = {
    ...bearerHeaders("docker-token"),
    ...clientHeaders("1.0.0"),
    Accept: "application/json",
  };
  assert.deepEqual(merged, {
    Authorization: "Bearer docker-token",
    "X-Feynman-Client": "obsidian-plugin/1.0.0",
    Accept: "application/json",
  });
});
