// Compile-time exhaustiveness test for the chat-view event-ingest switch.
//
// This file is INTENTIONALLY not a `.test.ts` — it has no runtime assertions.
// Its only job is to fail `npx tsc --noEmit` if a new variant is added to
// `EventPayload` in `src/protocol/index.ts` without a matching case in
// `FeynmanChatView.ingest`. The mirror switch below uses the same `never`
// trick the production code uses; if the union grows, `_check satisfies never`
// stops typechecking and the build breaks loudly.
//
// To run this check, just run `npx tsc --noEmit` (already wired in
// `package.json`'s `typecheck` script and in the npm-test gate ordering).

import type { Event } from "../src/protocol";

function _exhaustiveCheck(event: Event): "checked" {
  switch (event.type) {
    case "agent.message":
    case "agent.thinking":
    case "agent.question":
    case "tool.call":
    case "tool.result":
    case "tool.approval_required":
    case "fs.read_request":
    case "fs.write_request":
    case "artifact.written":
    case "run.error":
    case "run.done":
      return "checked";
    default: {
      // If a new variant is added to EventPayload, `event` here is no longer
      // `never` and this line stops compiling. That is the entire point.
      const _check: never = event;
      void _check;
      return "checked";
    }
  }
}

// Reference the function so it isn't stripped as dead code; tsc still checks
// the body even if unused, but referencing it documents intent.
void _exhaustiveCheck;
