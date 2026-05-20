// HTTP + SSE transport client. See docs/ARCHITECTURE.md §5.
//
// One implementation serves all three deployment modes (§3) — only baseUrl
// and auth differ. SSE reconnect with Last-Event-ID (§5.4) lives here.
//
// We can't use the browser's native EventSource because it does not allow
// custom request headers (so no Authorization). Instead we drive a fetch()
// with `Accept: text/event-stream`, read the ReadableStream via a
// TextDecoderStream + line buffer, parse SSE frames manually, and expose
// the result as an AsyncIterable<Event>. Reconnect on socket drop with an
// exponential back-off and the latest seen event id sent as `Last-Event-ID`.

import { requestUrl } from "obsidian";

import {
  PATHS,
  type Event,
  type HealthResponse,
  type Input,
  type ManifestResponse,
  type RunRequest,
  type RunResponse,
  type RunStateResponse,
} from "../protocol";

import { bearerHeaders, clientHeaders } from "./auth";

// Bundled at build time via esbuild's JSON loader (resolveJsonModule is on in
// tsconfig). Used as the default `X-Feynman-Client` version when the caller
// of the client constructor doesn't pass one.
import manifestJson from "../../manifest.json";

// Fallback plugin version used only when the constructor caller doesn't
// supply one and the bundled `manifest.json` can't be imported. Kept in sync
// with `manifest.json:version` by hand — Distribution Engineer (Agent 1) bumps
// both in lockstep.
const FALLBACK_CLIENT_VERSION = "1.0.0";

export interface FeynmanClientOptions {
  baseUrl: string;
  getAuth: () => string | null;
  /**
   * Plugin version string for the `X-Feynman-Client` header. Optional — when
   * omitted the client tries to import `manifest.json` and ultimately falls
   * back to a hard-coded constant. `main.ts` (Wave 3 Agent 6) will pass this
   * explicitly from the loaded manifest.
   */
  clientVersion?: string;
}

export interface OpenEventsOptions {
  // Accepts string per SSE spec (framing `id:` is opaque text), or number for
  // backward compatibility with the original numeric protocol id.
  lastEventId?: string | number;
  /**
   * Fires whenever a non-empty SSE framing `id:` is observed on a delivered
   * frame. Used by the workflow-runner to persist resume state. The transport
   * client uses framing ids as the source of truth for Last-Event-ID on
   * reconnect; this callback lets consumers persist that value out-of-band.
   */
  onFramingId?: (eventId: string) => void;
}

export interface EventStream extends AsyncIterable<Event> {
  close(): void;
}

// Back-off schedule for SSE reconnect attempts (§5.4 mandates "exponential",
// capped). 250 ms → 1 s → 4 s → 10 s (then sticks at 10 s). Each computed
// delay is jittered to `delay * (0.5 + Math.random())` at the call site.
const RECONNECT_DELAYS_MS = [250, 1000, 4000, 10_000] as const;

const SSE_GONE_STATUS = 409;

// Threshold for "the stream stayed alive long enough that the previous open
// was clearly successful, so subsequent drops should start the back-off
// schedule from scratch." 30 s matches the reconnect-accounting fix in
// `.pm/release-review/04-transport-protocol.md`.
const STREAM_ALIVE_RESET_MS = 30_000;

// Cap on buffered events between SSE producer and async-iterator consumer.
// Overflow triggers a synthetic `run.error` and finishes the stream so a
// hung consumer can't leak unbounded memory.
const MAX_QUEUE_LENGTH = 10_000;

// Per-non-SSE-request timeout. v1 keeps a single bound rather than separate
// connect vs total deadlines — easier to reason about, plenty for loopback +
// the modest body sizes we exchange.
const HTTP_TIMEOUT_MS = 30_000;

// Per-`reader.read()` watchdog. If the SSE socket goes silent for this long
// (no events, no `:keepalive` comments, no body bytes) we abort the body and
// let the outer loop reconnect. Catches half-open sockets that don't surface
// as TCP RSTs to the renderer process.
const SSE_READ_WATCHDOG_MS = 25_000;

/**
 * Compute the reconnect delay for the `attempt`-th consecutive failure.
 * Exported for testability — Agent 7's reconnect.test.ts asserts the jitter
 * range. Schedule lives in `RECONNECT_DELAYS_MS`; jitter expands each base
 * delay to `[0.5x, 1.5x)`.
 */
export function computeBackoff(attempt: number): number {
  const idx = Math.min(attempt, RECONNECT_DELAYS_MS.length - 1);
  const base = RECONNECT_DELAYS_MS[idx] ?? 10_000;
  // Jitter: spread retries across the [0.5x, 1.5x) window so a fleet of
  // reconnecting clients doesn't dog-pile a recovering server.
  return base * (0.5 + Math.random());
}

function reconnectDelay(attempt: number): number {
  return computeBackoff(attempt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Scrub secrets that may have leaked into a server-emitted error body before
 * surfacing them through `new Error(...)` (which often lands in `new Notice`
 * or a console log). Keeps the structure recognizable but redacts the value. */
function scrubSecrets(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/sk-ant-[A-Za-z0-9\-_]+/gi, "sk-ant-***")
    .replace(/Authorization:\s*[^\r\n]+/gi, "Authorization: ***");
}

/** Hard cap on user-facing error bodies (notices, console). Server can
 * return arbitrary HTML on a 5xx; we don't want the chat view rendering it. */
const ERROR_BODY_MAX = 200;

/** Truncate a scrubbed error body to ERROR_BODY_MAX, appending an ellipsis
 * when we cut. Safe for `new Notice(...)` and chat-view error callouts. */
function truncateBody(body: string): string {
  if (body.length <= ERROR_BODY_MAX) return body;
  return body.slice(0, ERROR_BODY_MAX) + "…";
}

/**
 * Build the user-visible error string for a non-OK HTTP response. Maps known
 * codes (401/403/404/5xx) onto specific short messages; falls back to
 * `Connection failed (HTTP NNN)` for anything else. Body is scrubbed then
 * truncated to ERROR_BODY_MAX chars.
 */
function formatHttpError(
  status: number,
  statusText: string,
  rawBody: string,
  url?: string,
): string {
  const safeDetail = rawBody.length > 0 ? truncateBody(scrubSecrets(rawBody)) : "";
  // Known codes: keep status + text + safe body so the user has actionable
  // signal. Unknown codes: collapse to the generic message — opaque bodies
  // (e.g. proxy 502 HTML) are useless in a Notice.
  const isKnown =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    (status >= 500 && status < 600);
  if (!isKnown) {
    return `Connection failed (HTTP ${String(status)})`;
  }
  const urlPart = url !== undefined && url.length > 0 ? ` (${url})` : "";
  return `HTTP ${String(status)} ${statusText}${urlPart}${safeDetail ? `: ${safeDetail}` : ""}`;
}

/**
 * One parsed SSE frame (the union of multi-line `data:` payload, the
 * trailing `id:`, and the optional `event:` discriminator).
 */
export type SseFrame = {
  id?: string;
  event?: string;
  data: string;
};

/**
 * Stateful, byte-stream-agnostic SSE frame parser. The transport client feeds
 * decoded text chunks into `feed()`; completed frames surface via the
 * `onFrame` callback. Exported so Agent 7 can drive it with synthetic
 * fixtures (CRLF/LF, multi-line data:, comments, BOM, unknown fields)
 * without instantiating the full client.
 *
 * Spec references: RFC 8895 / WHATWG `eventsource` §9.2.6.
 */
export class SseFrameBuilder {
  private buf = "";
  private currentData: string[] = [];
  private currentId: string | undefined = undefined;
  private currentEvent: string | undefined = undefined;
  private bomStripped = false;

  constructor(private readonly onFrame: (frame: SseFrame) => void) {}

  /** Push the next decoded text chunk. Flushes any completed frames inline. */
  feed(chunk: string): void {
    let next = chunk;
    if (!this.bomStripped) {
      // Strip a leading UTF-8 BOM at most once per stream. Some upstream
      // proxies prepend `0xEF 0xBB 0xBF` (surfaces as U+FEFF after decode);
      // without this strip the first JSON parse downstream fails.
      if (next.charCodeAt(0) === 0xfeff) {
        next = next.slice(1);
      }
      this.bomStripped = true;
    }
    this.buf += next;
    let nlIdx = this.buf.indexOf("\n");
    while (nlIdx !== -1) {
      let line = this.buf.slice(0, nlIdx);
      this.buf = this.buf.slice(nlIdx + 1);
      // CRLF tolerant.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line);
      nlIdx = this.buf.indexOf("\n");
    }
  }

  private processLine(line: string): void {
    if (line.length === 0) {
      // Frame boundary.
      if (this.currentData.length > 0 || this.currentId !== undefined) {
        this.flush();
      }
      return;
    }
    if (line.startsWith(":")) {
      // Comment (e.g. `:keepalive`). Spec §9.2.6: ignore.
      return;
    }
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      // Spec: a line with no colon is treated as the field name with empty
      // value (`event\n` → field=event value="").
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "data") {
      this.currentData.push(value);
    } else if (field === "id") {
      this.currentId = value;
    } else if (field === "event") {
      this.currentEvent = value;
    }
    // Unknown fields (including `retry`) are ignored per spec — the transport
    // client doesn't honor server-supplied retry; back-off lives in
    // `computeBackoff`.
  }

  private flush(): void {
    const data = this.currentData.join("\n");
    this.onFrame({
      id: this.currentId,
      event: this.currentEvent,
      data,
    });
    this.currentData = [];
    this.currentId = undefined;
    this.currentEvent = undefined;
  }
}

/** Build a synthetic `run.error` Event. Used when the transport itself fails
 * in a way the consumer needs to render (auth, unknown-run, slow-consumer,
 * 409 Gone). `id` is `-1` because synthetic events do not occupy a server
 * sequence slot — they're outside the Last-Event-ID resume window. */
function syntheticRunError(code: string, message: string): Event {
  return {
    id: -1,
    ts: Date.now(),
    type: "run.error",
    code,
    message,
  };
}

/** Promise.race wrapper that rejects after `ms` with an AbortError-equivalent.
 * Used for the per-read watchdog. */
function withReadTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new DOMException("SSE read watchdog timeout", "AbortError"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class FeynmanClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | null;
  private readonly clientVersion: string;
  // Tracks every active SSE stream's AbortController so `closeAllStreams()`
  // can tear them all down on plugin unload / client swap.
  private readonly activeStreams = new Set<AbortController>();

  constructor(opts: FeynmanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getAuth = opts.getAuth;
    this.clientVersion = opts.clientVersion ?? resolveDefaultClientVersion();
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...bearerHeaders(this.getAuth()),
      ...clientHeaders(this.clientVersion),
      ...extra,
    };
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore — fall through with status only
      }
      throw new Error(formatHttpError(res.status, res.statusText, detail, res.url));
    }
    return (await res.json()) as T;
  }

  /**
   * Non-streaming request helper that goes through Obsidian's `requestUrl`.
   * The renderer's `fetch()` enforces CORS preflight on the Authorization +
   * X-Feynman-Client headers we send, and the local Feynman server doesn't
   * return Access-Control-Allow-Origin headers — so `fetch` is blocked.
   * `requestUrl` runs in the Electron main process and isn't subject to
   * CORS. SSE stays on `fetch` because `requestUrl` can't stream.
   */
  private async requestJson<T>(opts: {
    path: string;
    method?: "GET" | "POST";
    extraHeaders?: Record<string, string>;
    body?: string;
    /** Tolerate this exact non-2xx status as success. Used for cancel(204). */
    okStatus?: number;
  }): Promise<T> {
    const res = await requestUrl({
      url: this.url(opts.path),
      method: opts.method ?? "GET",
      headers: this.headers(opts.extraHeaders),
      body: opts.body,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      if (opts.okStatus !== undefined && res.status === opts.okStatus) {
        return undefined as T;
      }
      throw new Error(
        formatHttpError(res.status, "", res.text, this.url(opts.path)),
      );
    }
    // requestUrl exposes `.json` (parsed from `.text` if Content-Type is JSON).
    // For void-typed methods, callers ignore the return.
    return res.json as T;
  }

  async health(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>({
      path: PATHS.health,
      extraHeaders: { Accept: "application/json" },
    });
  }

  async manifest(): Promise<ManifestResponse> {
    return this.requestJson<ManifestResponse>({
      path: PATHS.manifest,
      extraHeaders: { Accept: "application/json" },
    });
  }

  async getRun(runId: string): Promise<RunStateResponse> {
    return this.requestJson<RunStateResponse>({
      path: PATHS.runState(runId),
      extraHeaders: { Accept: "application/json" },
    });
  }

  async cancel(runId: string): Promise<void> {
    await this.requestJson<void>({
      path: PATHS.runCancel(runId),
      method: "POST",
      okStatus: 204,
    });
  }

  async postInput(runId: string, input: Input): Promise<void> {
    await this.requestJson<void>({
      path: PATHS.runInput(runId),
      method: "POST",
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async postRun(req: RunRequest): Promise<RunResponse> {
    // Idempotency-Key: protects against duplicate `POST /v1/run` from network
    // retries / accidental double-click. Server dedupes on this key for a
    // bounded window (§5.4 dedupe contract).
    const idempotencyKey = generateIdempotencyKey();
    return this.requestJson<RunResponse>({
      path: PATHS.run,
      method: "POST",
      extraHeaders: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(req),
    });
  }

  /**
   * Abort every in-flight SSE stream this client owns. Safe to call multiple
   * times. Wired by Agent 6 in Wave 3 from `main.ts:refreshConnection` and
   * `onunload` so a baseUrl swap doesn't leak streams against the prior URL.
   */
  closeAllStreams(): void {
    // Snapshot first — `abort()` triggers handlers that call `delete` on the
    // set, which would mutate during iteration.
    const controllers = Array.from(this.activeStreams);
    this.activeStreams.clear();
    for (const ctrl of controllers) {
      try {
        ctrl.abort();
      } catch {
        // ignore — already-aborted controllers throw nothing useful here
      }
    }
  }

  /**
   * Open an SSE event stream for a run. Returns a closable AsyncIterable.
   * Honors `Last-Event-ID` across reconnects, backs off exponentially on
   * drops, surfaces 409 Gone / 401 / 403 / 404 as synthetic `run.error`
   * events and stops trying. 5xx and network errors retry.
   */
  openEvents(runId: string, opts: OpenEventsOptions = {}): EventStream {
    const abort = new AbortController();
    this.activeStreams.add(abort);
    const url = this.url(PATHS.runEvents(runId));
    const initialLastEventId =
      opts.lastEventId !== undefined ? String(opts.lastEventId) : undefined;
    const onFramingId = opts.onFramingId;
    const headersBase = (): Record<string, string> =>
      this.headers({ Accept: "text/event-stream" });

    // Single queue feeding the async iterator. Producers push; the consumer
    // pulls via `next()`. End-of-stream is signaled with `done = true`. We
    // cap the queue at MAX_QUEUE_LENGTH; overflow synthesizes a `slow-consumer`
    // run.error and finishes the stream.
    const queue: Event[] = [];
    let resolver: ((v: IteratorResult<Event>) => void) | null = null;
    let done = false;
    let overflowed = false;

    const push = (ev: Event): void => {
      if (overflowed) return;
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r({ value: ev, done: false });
        return;
      }
      if (queue.length >= MAX_QUEUE_LENGTH) {
        overflowed = true;
        // Drop the new event, surface the overflow once, and shut down. We
        // deliver the synthetic error via the same resolver/queue path so
        // the consumer can render it.
        const err = syntheticRunError(
          "slow-consumer",
          "Event queue overflow — UI cannot keep up",
        );
        queue.push(err);
        // Schedule a finish after the synthetic error so the consumer drains
        // it before seeing `done`.
        queueMicrotask(() => finish());
        return;
      }
      queue.push(ev);
    };

    // Tracks whether the last delivered event was a terminal one (`run.done`
    // / `run.error`). When the body ends, this tells us whether to reconnect
    // (transient drop) or resolve cleanly (server-side terminus).
    let lastEventWasTerminal = false;

    // finish() is now an unconditional resolve. Any error condition is
    // delivered as a synthetic `run.error` event pushed BEFORE finish() is
    // called, so the consumer's iterator gets the error info via the normal
    // event stream rather than via a thrown rejection.
    const finish = (): void => {
      if (done) return;
      done = true;
      this.activeStreams.delete(abort);
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r({ value: undefined, done: true });
      }
    };

    let lastSeenId: string | undefined = initialLastEventId;
    // Hook so the workflow-runner can persist lastEventId as it advances.
    // Set via the returned stream object's extra property (kept off the
    // public EventStream interface — workflow-runner reads framing ids
    // directly off the events it observes).

    const consume = async (): Promise<void> => {
      let attempt = 0;
      while (!abort.signal.aborted) {
        const streamStartTime = Date.now();
        lastEventWasTerminal = false;
        const headers = headersBase();
        if (lastSeenId !== undefined) {
          headers["Last-Event-ID"] = lastSeenId;
        }
        let res: Response;
        try {
          res = await fetch(url, {
            method: "GET",
            headers,
            signal: abort.signal,
          });
        } catch {
          // Network throw — retry with backoff. Not a transient body drop,
          // so don't reset `attempt`.
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        // Error mapping. Auth and unknown-run are terminal: emit a synthetic
        // run.error so the chat view can render it, then finish without
        // retrying. 5xx falls through to the back-off path.
        if (res.status === 401 || res.status === 403) {
          push(syntheticRunError("auth-failed", "Authentication failed"));
          finish();
          return;
        }
        if (res.status === 404) {
          push(syntheticRunError("unknown-run", `Run ${runId} not found`));
          finish();
          return;
        }
        if (res.status === SSE_GONE_STATUS) {
          push(
            syntheticRunError(
              "stream-lost",
              "Stream evicted; run continued on server",
            ),
          );
          finish();
          return;
        }
        if (res.status >= 500 && res.status < 600) {
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        if (!res.ok || res.body === null) {
          // Anything else non-OK we treat as retryable for the moment —
          // future codes (e.g. 429) can be folded in here without changing
          // the structural pattern.
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        try {
          await this.readSseBody(res.body, abort.signal, (frame) => {
            // SSE comments (lines beginning with `:`) never reach here — the
            // reader drops them at parse time. Frames with empty data are
            // also dropped (no-op heartbeats).
            if (frame.data.length === 0) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              return; // malformed frame — skip
            }
            const ev = parsed as Event;
            // SSE framing `id:` is the source of truth for Last-Event-ID
            // (RFC 8895 §5.4). The application-level `ev.id` is kept for
            // consumer use but is not what we send on reconnect.
            if (frame.id !== undefined && frame.id.length > 0) {
              lastSeenId = frame.id;
              if (onFramingId !== undefined) {
                try {
                  onFramingId(frame.id);
                } catch {
                  // Consumer hook errors must never destabilise the stream.
                }
              }
            }
            push(ev);
            // Terminal events (§5.4): once we observe `run.done` or
            // `run.error`, the run is finished server-side. Mark terminal so
            // the post-loop logic below resolves cleanly instead of
            // reconnecting against a buffer that no longer accepts events.
            if (ev.type === "run.done" || ev.type === "run.error") {
              lastEventWasTerminal = true;
              finish();
              abort.abort();
            }
          });
        } catch {
          // Watchdog timeout or reader exception — abort the in-flight body
          // (no-op if already aborted) and let the back-off path retry.
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        // Body ended cleanly.
        if (abort.signal.aborted) return;
        if (lastEventWasTerminal) {
          // The last delivered event closed the run on the server side; do
          // not loop back to reconnect. finish() was already called from the
          // terminal branch above.
          return;
        }
        // Reconnect accounting: only reset `attempt` to 0 when the stream
        // stayed alive long enough that the previous open clearly succeeded.
        // Otherwise back-to-back drops would loop with `delay=250ms` forever.
        if (Date.now() - streamStartTime >= STREAM_ALIVE_RESET_MS) {
          attempt = 0;
        } else {
          attempt += 1;
        }
        await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
      }
    };

    // Kick off the consumer loop. Unexpected exceptions surface as synthetic
    // run.error events so the consumer iterator never rejects — this matches
    // the standardized resolve-only `finish()` contract.
    consume().catch((err: unknown) => {
      push(
        syntheticRunError(
          "stream-failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
      finish();
    });

    const stream: EventStream = {
      close(): void {
        abort.abort();
        finish();
      },
      [Symbol.asyncIterator](): AsyncIterator<Event> {
        return {
          next(): Promise<IteratorResult<Event>> {
            if (queue.length > 0) {
              const ev = queue.shift() as Event;
              return Promise.resolve({ value: ev, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<Event>>((resolve) => {
              resolver = resolve;
            });
          },
          return(): Promise<IteratorResult<Event>> {
            abort.abort();
            finish();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };

    return stream;
  }

  /**
   * Read an SSE response body as a stream of frames. Splits on `\n`,
   * accumulates `data:` lines into a single payload, drops comment lines
   * (`:`), and flushes a frame on each blank line. Resolves when the body
   * ends; rejects if the reader throws or the per-read watchdog fires.
   */
  private async readSseBody(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onFrame: (frame: SseFrame) => void,
  ): Promise<void> {
    // `TextDecoderStream` types are stricter than what `body.pipeThrough`
    // expects in some lib.dom versions (writable accepts BufferSource but
    // pipeThrough wants Uint8Array). The runtime pairing works fine; cast
    // through the standard adapter type to satisfy the compiler.
    const decoder = new TextDecoderStream();
    const stream = body.pipeThrough(
      decoder as unknown as ReadableWritablePair<string, Uint8Array>,
    );
    const reader = stream.getReader();
    // All frame-parsing state (line buffer, current-frame fields, BOM strip)
    // lives in SseFrameBuilder so the same code path is exercised by
    // tests/sse-parser.test.ts.
    const builder = new SseFrameBuilder(onFrame);

    // Per-read watchdog: an idle connection that's stopped emitting even
    // `:keepalive` comments is likely half-open. After SSE_READ_WATCHDOG_MS
    // we abort the body so the outer reconnect loop can re-open.
    const watchdogAbort = (): void => {
      try {
        // Cancel the underlying body so reader.read() rejects promptly on
        // the next iteration; the outer catch will retry.
        void reader.cancel();
      } catch {
        // ignore
      }
    };

    try {
      while (!signal.aborted) {
        const result = await withReadTimeout(
          reader.read(),
          SSE_READ_WATCHDOG_MS,
          watchdogAbort,
        );
        const { value, done } = result;
        if (done) break;
        builder.feed(value);
      }
      // Any trailing buffered frame is intentionally dropped — SSE requires
      // a blank-line terminator and an unterminated frame is not valid.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore — lock release on an already-released reader is harmless
      }
    }
  }
}

/** Generate an Idempotency-Key for `POST /v1/run`. Uses crypto.randomUUID()
 * when available (Electron 25+, all supported Obsidian builds); falls back to
 * a Math.random()-based id only on ancient runtimes — the fallback should
 * never execute in production. */
function generateIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID !== undefined) {
    return g.crypto.randomUUID();
  }
  // Defensive fallback — not cryptographically strong, but uniqueness is the
  // only requirement here, and the surrounding runtime context always has
  // crypto.randomUUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Resolve the plugin version for `X-Feynman-Client` when no clientVersion is
 * passed to the constructor. Uses the bundled `manifest.json` import; falls
 * back to the hard-coded constant only if the manifest is missing a version
 * field (which would also fail the Obsidian plugin loader). */
function resolveDefaultClientVersion(): string {
  const v = (manifestJson as { version?: unknown }).version;
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  return FALLBACK_CLIENT_VERSION;
}
