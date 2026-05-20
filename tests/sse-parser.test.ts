// Coverage: hand-rolled SSE parser in src/transport/client.ts
//
// Approach: Agent 7 refactored the parser body out of FeynmanClient into an
// exported `SseFrameBuilder` (≈25 LOC delta in client.ts). The class is fed
// decoded text chunks and emits `SseFrame` objects via a callback. The same
// instance is used by the production `readSseBody`, so anything we assert
// here applies to the live transport.
//
// Cases covered (per Agent 7 spec):
//   - LF line endings
//   - CRLF line endings
//   - multi-line `data:` fields (concatenated with \n)
//   - comment lines (start with `:`) — ignored
//   - BOM prefix stripped exactly once at buffer head
//   - field with no colon (e.g. `event\n`) — field name with empty value
//   - unknown fields (`retry: 5000`) — harmlessly ignored

import { test } from "node:test";
import assert from "node:assert/strict";

import { SseFrameBuilder, type SseFrame } from "../src/transport/client";

function collect(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const builder = new SseFrameBuilder((f) => frames.push(f));
  for (const chunk of chunks) builder.feed(chunk);
  return frames;
}

test("parses a single LF-terminated frame", () => {
  const frames = collect([
    "id: 1\n",
    "event: agent.message\n",
    'data: {"hello":"world"}\n',
    "\n",
  ]);
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.ok(f);
  assert.equal(f.id, "1");
  assert.equal(f.event, "agent.message");
  assert.equal(f.data, '{"hello":"world"}');
});

test("parses CRLF line endings identically to LF", () => {
  const frames = collect([
    "id: 7\r\n",
    "data: ok\r\n",
    "\r\n",
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.id, "7");
  assert.equal(frames[0]?.data, "ok");
});

test("concatenates multi-line data: fields with \\n", () => {
  const frames = collect([
    "id: 9\n",
    "data: line-one\n",
    "data: line-two\n",
    "data: line-three\n",
    "\n",
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, "line-one\nline-two\nline-three");
  assert.equal(frames[0]?.id, "9");
});

test("ignores comment lines (lines starting with ':')", () => {
  const frames = collect([
    ":keepalive\n",
    ":another comment\n",
    "id: 2\n",
    "data: payload\n",
    "\n",
    ":keepalive\n",
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, "payload");
});

test("strips a leading UTF-8 BOM (U+FEFF) exactly once", () => {
  const frames = collect([
    "﻿id: 3\ndata: bom-payload\n\n",
    // A second `﻿` mid-stream is just data, not a BOM.
    "id: 4\ndata: ﻿inside\n\n",
  ]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.id, "3");
  assert.equal(frames[0]?.data, "bom-payload");
  assert.equal(frames[1]?.id, "4");
  // BOM mid-stream is preserved as part of the data field per spec; only the
  // very first byte gets stripped. Verify the second BOM isn't dropped.
  assert.equal(frames[1]?.data, "﻿inside");
});

test("field with no colon is treated as field name with empty value", () => {
  // Per WHATWG eventsource §9.2.6: `event\n` → field="event" value="".
  // No frame fires because there's no `data:` line; assert by adding one.
  const frames = collect([
    "event\n",
    "id: 5\n",
    "data: x\n",
    "\n",
  ]);
  assert.equal(frames.length, 1);
  // `event:` with empty value means the discriminator is "" (we don't drop it
  // — the production code keeps whatever was set; here it's the empty string
  // because we explicitly set field=event, value="").
  assert.equal(frames[0]?.event, "");
  assert.equal(frames[0]?.id, "5");
  assert.equal(frames[0]?.data, "x");
});

test("unknown fields (retry, foo) are harmlessly ignored", () => {
  const frames = collect([
    "retry: 5000\n",
    "foo: bar\n",
    "id: 6\n",
    "data: payload\n",
    "\n",
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.id, "6");
  assert.equal(frames[0]?.data, "payload");
  // Unknown fields don't leak into the frame.
  assert.equal((frames[0] as Record<string, unknown>).retry, undefined);
  assert.equal((frames[0] as Record<string, unknown>).foo, undefined);
});

test("splits chunked input across frame boundaries", () => {
  // Bytes arrive in the order TCP delivers them, not aligned to frame
  // boundaries. Verify the parser tolerates being fed a single line broken
  // across multiple `feed()` calls.
  const frames = collect([
    "id: 1\nda",
    "ta: hel",
    "lo\n\nid: 2\ndata: w",
    "orld\n\n",
  ]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.data, "hello");
  assert.equal(frames[1]?.data, "world");
});

test("drops empty-data frames that have no id either", () => {
  // A bare blank line with no fields should not emit a frame — otherwise the
  // production `onFrame` callback would receive {data: ""} on every keepalive.
  const frames = collect(["\n\n\n"]);
  assert.equal(frames.length, 0);
});

test("leading space after colon is stripped (spec)", () => {
  const frames = collect([
    "data:no-space\n",
    "data: with-space\n",
    "\n",
  ]);
  assert.equal(frames.length, 1);
  // Per spec, exactly one leading space after the colon is stripped.
  assert.equal(frames[0]?.data, "no-space\nwith-space");
});
