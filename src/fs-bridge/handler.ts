// FS-bridge handler — services `fs.read_request` and `fs.write_request`
// events from the server when the vault is not mounted (self-hosted v2,
// Managed Modal). See docs/ARCHITECTURE.md §5.2 and §6.2/§6.3.
//
// Replies go back via POST /v1/runs/:id/input with `fs.read_response` /
// `fs.write_response` payloads (see protocol Input union).
//
// Stub: every method throws.

import type { Event, Input } from "@feynman/protocol";

// The fs request events are a subset of the SSE Event union. We narrow at
// the call site rather than redefining the shapes here.
type FsReadRequest = Extract<Event, { type: "fs.read_request" }>;
type FsWriteRequest = Extract<Event, { type: "fs.write_request" }>;
type FsReadResponse = Extract<Input, { type: "fs.read_response" }>;
type FsWriteResponse = Extract<Input, { type: "fs.write_response" }>;

export class FsBridgeHandler {
  async handleReadRequest(_req: FsReadRequest): Promise<FsReadResponse> {
    throw new Error("not implemented");
  }

  async handleWriteRequest(_req: FsWriteRequest): Promise<FsWriteResponse> {
    throw new Error("not implemented");
  }
}
