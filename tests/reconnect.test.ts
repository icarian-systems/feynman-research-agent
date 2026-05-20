// Coverage: reconnect-accounting + jitter in src/transport/client.ts.
//
// Scope decision (per Agent 7 plan): the full `openEvents()` reconnect loop is
// intertwined with `fetch`, AbortController, and the SSE body reader. Stubbing
// all of that to drive the loop deterministically is a substantial amount of
// scaffolding that doesn't pay back compared to testing the actual rule the
// reconnect logic encodes:
//
//   1. `computeBackoff(attempt)` returns a base delay scaled by jitter in
//      `[0.5x, 1.5x)`.
//   2. The schedule is 250 ms → 1 s → 4 s → 10 s, then sticks at 10 s.
//   3. Across many invocations at the same `attempt`, the result spans the
//      jitter window (not deterministic).
//
// Agent 7 exported `computeBackoff` from client.ts (small ≤5 LOC refactor) for
// this purpose. The 30-second stream-alive-reset rule is read directly off
// the constant `STREAM_ALIVE_RESET_MS = 30_000` in the production file
// (assertion below pins it).
//
// What's NOT tested here: the live reconnect loop interplay with `fetch` and
// stream lifetimes — that is exercised by the manual checklist
// (docs/TESTING.md: "Run a workflow. Stop Docker mid-stream...") because
// simulating a half-open socket inside Node's test runner requires either a
// loopback HTTP server or a deep MSW-style mock; both are out of scope for v1.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBackoff } from "../src/transport/client";

test("computeBackoff: attempt=0 lands in [125, 375) ms", () => {
  // Base 250 ms × [0.5, 1.5) = [125, 375).
  for (let i = 0; i < 100; i++) {
    const d = computeBackoff(0);
    assert.ok(d >= 125 && d < 375, `out of range: ${String(d)}`);
  }
});

test("computeBackoff: attempt=1 lands in [500, 1500) ms", () => {
  for (let i = 0; i < 100; i++) {
    const d = computeBackoff(1);
    assert.ok(d >= 500 && d < 1500, `out of range: ${String(d)}`);
  }
});

test("computeBackoff: attempt=2 lands in [2000, 6000) ms", () => {
  for (let i = 0; i < 100; i++) {
    const d = computeBackoff(2);
    assert.ok(d >= 2000 && d < 6000, `out of range: ${String(d)}`);
  }
});

test("computeBackoff: attempt=3 lands in [5000, 15000) ms", () => {
  for (let i = 0; i < 100; i++) {
    const d = computeBackoff(3);
    assert.ok(d >= 5000 && d < 15000, `out of range: ${String(d)}`);
  }
});

test("computeBackoff: saturates at attempt=N for large N (still [5000, 15000))", () => {
  // After exhausting the schedule, the helper sticks at the last entry
  // (10 s) ± jitter. Try a few large attempt counts.
  for (const attempt of [4, 5, 10, 100, 10_000]) {
    for (let i = 0; i < 25; i++) {
      const d = computeBackoff(attempt);
      assert.ok(
        d >= 5000 && d < 15000,
        `attempt=${String(attempt)} out of range: ${String(d)}`,
      );
    }
  }
});

test("computeBackoff: jitter is non-deterministic across calls (not always the same value)", () => {
  // Hard guarantee: 100 samples at the same attempt produce >1 distinct value.
  const samples = new Set<number>();
  for (let i = 0; i < 100; i++) {
    samples.add(computeBackoff(2));
  }
  assert.ok(
    samples.size > 1,
    `expected jitter to produce distinct samples; got ${String(samples.size)}`,
  );
});

test("computeBackoff: with Math.random pinned, output is the deterministic min-end of the jitter window", () => {
  // Mock Math.random to exactly 0 → multiplier is 0.5 → result is base × 0.5.
  const original = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(computeBackoff(0), 125); // 250 * 0.5
    assert.equal(computeBackoff(1), 500); // 1000 * 0.5
    assert.equal(computeBackoff(2), 2000); // 4000 * 0.5
    assert.equal(computeBackoff(3), 5000); // 10000 * 0.5
    assert.equal(computeBackoff(100), 5000); // saturated at 10000 * 0.5
  } finally {
    Math.random = original;
  }
});

test("computeBackoff: with Math.random pinned just under 1, output is just under the max-end", () => {
  const original = Math.random;
  try {
    // Math.random ∈ [0, 1) — use 0.999...
    Math.random = () => 0.9999999;
    // 250 × (0.5 + 0.9999999) = 250 × 1.4999999 ≈ 374.99999
    const d = computeBackoff(0);
    assert.ok(d > 374.9 && d < 375, `${String(d)} not just under 375`);
  } finally {
    Math.random = original;
  }
});

// -------------------- Reconnect-accounting rule (constant pin) --------

test("STREAM_ALIVE_RESET_MS is 30 s — the reconnect-accounting threshold", async () => {
  // Pin the constant via grep of the source. The rule itself ("only reset
  // attempt to 0 after the stream stayed alive ≥ 30 s") is enforced inside
  // the `consume()` async function and isn't easily isolatable without a
  // full mock-fetch harness. We pin the threshold here so a careless edit
  // doesn't drop it to 0 (which would re-introduce the original
  // back-to-back-drop infinite-250 ms-loop bug).
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../src/transport/client.ts", import.meta.url),
    "utf8",
  );
  // Match either the named constant or the literal as a defense against
  // refactors.
  assert.ok(
    /STREAM_ALIVE_RESET_MS\s*=\s*30_000/.test(src),
    "STREAM_ALIVE_RESET_MS must remain 30_000",
  );
  // And the consume loop must compare elapsed against it via `>=`.
  assert.ok(
    /Date\.now\(\)\s*-\s*streamStartTime\s*>=\s*STREAM_ALIVE_RESET_MS/.test(src),
    "consume() must gate `attempt = 0` reset on >= STREAM_ALIVE_RESET_MS",
  );
});
