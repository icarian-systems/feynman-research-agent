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

import {
  PATHS,
  type Event,
  type HealthResponse,
  type Input,
  type ManifestResponse,
  type RunRequest,
  type RunResponse,
  type RunStateResponse,
} from "@feynman/protocol";

import { bearerHeaders } from "./auth";

export interface FeynmanClientOptions {
  baseUrl: string;
  getAuth: () => string | null;
}

export interface OpenEventsOptions {
  lastEventId?: number;
}

export interface EventStream extends AsyncIterable<Event> {
  close(): void;
}

// Back-off schedule for SSE reconnect attempts (§5.4 mandates "exponential",
// capped). 250 ms → 1 s → 4 s → 10 s (then sticks at 10 s).
const RECONNECT_DELAYS_MS = [250, 1000, 4000, 10_000] as const;

const SSE_GONE_STATUS = 409;

function reconnectDelay(attempt: number): number {
  const idx = Math.min(attempt, RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[idx] ?? 10_000;
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

/**
 * One parsed SSE frame (the union of multi-line `data:` payload, the
 * trailing `id:`, and the optional `event:` discriminator).
 */
type SseFrame = {
  id?: string;
  event?: string;
  data: string;
};

export class FeynmanClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | null;

  constructor(opts: FeynmanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getAuth = opts.getAuth;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...bearerHeaders(this.getAuth()),
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
      throw new Error(
        `HTTP ${res.status} ${res.statusText} (${res.url})${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  async health(): Promise<HealthResponse> {
    const res = await fetch(this.url(PATHS.health), {
      method: "GET",
      headers: this.headers({ Accept: "application/json" }),
    });
    return this.json<HealthResponse>(res);
  }

  async manifest(): Promise<ManifestResponse> {
    const res = await fetch(this.url(PATHS.manifest), {
      method: "GET",
      headers: this.headers({ Accept: "application/json" }),
    });
    return this.json<ManifestResponse>(res);
  }

  async getRun(runId: string): Promise<RunStateResponse> {
    const res = await fetch(this.url(PATHS.runState(runId)), {
      method: "GET",
      headers: this.headers({ Accept: "application/json" }),
    });
    return this.json<RunStateResponse>(res);
  }

  async cancel(runId: string): Promise<void> {
    const res = await fetch(this.url(PATHS.runCancel(runId)), {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} cancelling run ${runId}`,
      );
    }
  }

  async postInput(runId: string, input: Input): Promise<void> {
    const res = await fetch(this.url(PATHS.runInput(runId)), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} ${res.statusText} posting input to ${runId}${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  async postRun(req: RunRequest): Promise<RunResponse> {
    const res = await fetch(this.url(PATHS.run), {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify(req),
    });
    return this.json<RunResponse>(res);
  }

  /**
   * Open an SSE event stream for a run. Returns a closable AsyncIterable.
   * Honors `Last-Event-ID` across reconnects, backs off exponentially on
   * drops, surfaces 409 Gone as a synthetic `run.error` and stops trying.
   */
  openEvents(runId: string, opts: OpenEventsOptions = {}): EventStream {
    const abort = new AbortController();
    const url = this.url(PATHS.runEvents(runId));
    const initialLastEventId = opts.lastEventId;
    const headersBase = (): Record<string, string> =>
      this.headers({ Accept: "text/event-stream" });

    // Single queue feeding the async iterator. Producers push; the consumer
    // pulls via `next()`. End-of-stream is signaled with `done = true`.
    const queue: Event[] = [];
    let resolver: ((v: IteratorResult<Event>) => void) | null = null;
    let done = false;
    let producerError: unknown = null;

    const push = (ev: Event): void => {
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    };

    const finish = (err?: unknown): void => {
      if (done) return;
      done = true;
      if (err !== undefined) {
        producerError = err;
      }
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        if (err !== undefined) {
          // Reject by throwing inside the iterator on next pull.
          r({ value: undefined, done: true });
        } else {
          r({ value: undefined, done: true });
        }
      }
    };

    let lastSeenId: number | undefined = initialLastEventId;

    const consume = async (): Promise<void> => {
      let attempt = 0;
      while (!abort.signal.aborted) {
        const headers = headersBase();
        if (lastSeenId !== undefined) {
          headers["Last-Event-ID"] = String(lastSeenId);
        }
        let res: Response;
        try {
          res = await fetch(url, {
            method: "GET",
            headers,
            signal: abort.signal,
          });
        } catch {
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        if (res.status === SSE_GONE_STATUS) {
          push({
            id: -1,
            ts: Date.now(),
            type: "run.error",
            code: "stream-lost",
            message: "Stream evicted; run continued on server",
          });
          finish();
          return;
        }

        if (!res.ok || res.body === null) {
          // Treat as a transient failure; back off and retry unless aborted.
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
          continue;
        }

        // Successful connection — reset the back-off counter.
        attempt = 0;

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
            if (typeof ev.id === "number") {
              lastSeenId = ev.id;
            } else if (
              frame.id !== undefined &&
              /^-?\d+$/.test(frame.id)
            ) {
              lastSeenId = Number(frame.id);
            }
            push(ev);
            // Terminal events (§5.4): once we observe `run.done` or
            // `run.error`, the run is finished server-side. Close the
            // stream and break the reconnect loop so we don't reopen
            // against a buffer that no longer accepts new events.
            if (ev.type === "run.done" || ev.type === "run.error") {
              finish();
              abort.abort();
            }
          });
          // Body ended. If a terminal event aborted us, exit cleanly; if
          // it was a transient drop, back off and reconnect — per §5.4
          // `run.done` is the iteration terminus, not socket close.
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
        } catch {
          if (abort.signal.aborted) return;
          await sleep(reconnectDelay(attempt), abort.signal).catch(() => {});
          attempt += 1;
        }
      }
    };

    // Kick off the consumer loop. Errors are captured in `producerError` and
    // re-thrown from the iterator's `next()`.
    consume().catch((err: unknown) => {
      finish(err);
    });

    const stream: EventStream = {
      close(): void {
        abort.abort();
        finish();
      },
      [Symbol.asyncIterator](): AsyncIterator<Event> {
        return {
          next(): Promise<IteratorResult<Event>> {
            if (producerError !== null) {
              const err = producerError;
              producerError = null;
              return Promise.reject(err);
            }
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
   * ends; rejects if the reader throws.
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
    let buf = "";
    let currentData: string[] = [];
    let currentId: string | undefined;
    let currentEvent: string | undefined;

    const flush = (): void => {
      const data = currentData.join("\n");
      onFrame({ id: currentId, event: currentEvent, data });
      currentData = [];
      currentId = undefined;
      currentEvent = undefined;
    };

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        // SSE delimits frames with blank lines. We process line by line so
        // each field can be assigned to the right slot in the pending frame.
        let nlIdx = buf.indexOf("\n");
        while (nlIdx !== -1) {
          let line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 1);
          // CRLF tolerant.
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.length === 0) {
            // Frame boundary.
            if (currentData.length > 0 || currentId !== undefined) {
              flush();
            }
          } else if (line.startsWith(":")) {
            // Comment (e.g. `:keepalive`). Spec §5.4: no-op.
          } else {
            const colon = line.indexOf(":");
            let field: string;
            let value: string;
            if (colon === -1) {
              field = line;
              value = "";
            } else {
              field = line.slice(0, colon);
              value = line.slice(colon + 1);
              if (value.startsWith(" ")) value = value.slice(1);
            }
            if (field === "data") {
              currentData.push(value);
            } else if (field === "id") {
              currentId = value;
            } else if (field === "event") {
              currentEvent = value;
            }
            // Unknown fields ignored per SSE spec.
          }
          nlIdx = buf.indexOf("\n");
        }
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
