/**
 * OAuth / login client. Wraps the server's `/v1/auth/*` surface for the
 * settings UI. Non-streaming methods go through Obsidian's `requestUrl`
 * (CORS preflight in the renderer would otherwise block) — only the SSE
 * stream uses `fetch`, because `requestUrl` can't deliver chunked data.
 */

import { requestUrl } from "obsidian";

import { bearerHeaders, clientHeaders } from "./auth";

export type OAuthProviderInfo = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
};

export type ConfiguredProvider = {
  id: string;
  type: "oauth" | "api_key";
};

export type LoginEvent =
  | { type: "auth"; url: string; instructions?: string }
  | {
      type: "prompt";
      promptId: string;
      message: string;
      placeholder?: string;
      allowEmpty?: boolean;
    }
  | {
      type: "select";
      promptId: string;
      message: string;
      options: { id: string; label: string }[];
    }
  | { type: "manual_code"; promptId: string }
  | { type: "progress"; message: string }
  | { type: "complete" }
  | { type: "error"; message: string };

export interface AuthClientOptions {
  baseUrl: string;
  getAuth: () => string | null;
  clientVersion: string;
}

export class AuthClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | null;
  private readonly clientVersion: string;

  constructor(opts: AuthClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getAuth = opts.getAuth;
    this.clientVersion = opts.clientVersion;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...bearerHeaders(this.getAuth()),
      ...clientHeaders(this.clientVersion),
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; okStatuses?: number[] } = {},
  ): Promise<T> {
    const res = await requestUrl({
      url: this.url(path),
      method: init.method ?? "GET",
      headers: this.headers(
        init.body !== undefined ? { "Content-Type": "application/json" } : {},
      ),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      throw: false,
    });
    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204) return undefined as T;
      try {
        return res.json as T;
      } catch {
        return undefined as T;
      }
    }
    if (init.okStatuses?.includes(res.status)) {
      return undefined as T;
    }
    const detail = (() => {
      try {
        const parsed = JSON.parse(res.text) as { error?: string };
        return parsed.error ?? res.text.slice(0, 200);
      } catch {
        return res.text.slice(0, 200);
      }
    })();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  async listProviders(): Promise<OAuthProviderInfo[]> {
    const out = await this.request<{ providers: OAuthProviderInfo[] }>(
      "/v1/auth/providers",
    );
    return out.providers ?? [];
  }

  async listConfigured(): Promise<ConfiguredProvider[]> {
    const out = await this.request<{ providers: ConfiguredProvider[] }>(
      "/v1/auth/configured",
    );
    return out.providers ?? [];
  }

  async startLogin(providerId: string): Promise<{ sessionId: string }> {
    return this.request<{ sessionId: string }>("/v1/auth/login", {
      method: "POST",
      body: { providerId },
    });
  }

  async respond(sessionId: string, promptId: string, value: string): Promise<void> {
    await this.request<void>(`/v1/auth/login/${sessionId}/respond`, {
      method: "POST",
      body: { promptId, value },
      okStatuses: [204],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request<void>(`/v1/auth/login/${sessionId}/cancel`, {
      method: "POST",
      okStatuses: [204, 404],
    });
  }

  async logout(providerId: string): Promise<void> {
    await this.request<void>("/v1/auth/logout", {
      method: "POST",
      body: { providerId },
      okStatuses: [204],
    });
  }

  // ---- alphaXiv -----------------------------------------------------------

  async getAlphaStatus(): Promise<{ loggedIn: boolean; userName: string | null }> {
    return this.request<{ loggedIn: boolean; userName: string | null }>(
      "/v1/auth/alpha/status",
    );
  }

  async startAlphaLogin(): Promise<{ sessionId: string }> {
    return this.request<{ sessionId: string }>("/v1/auth/alpha/login", {
      method: "POST",
    });
  }

  async cancelAlphaLogin(sessionId: string): Promise<void> {
    await this.request<void>(`/v1/auth/alpha/login/${sessionId}/cancel`, {
      method: "POST",
      okStatuses: [204, 404],
    });
  }

  async alphaLogout(): Promise<void> {
    await this.request<void>("/v1/auth/alpha/logout", {
      method: "POST",
      okStatuses: [204],
    });
  }

  /**
   * Open the SSE stream for an in-flight login session. Returns an
   * async iterator + close handle, mirroring the run-events stream shape.
   * Caller is responsible for calling `.close()` on unmount.
   */
  openEvents(
    sessionId: string,
    abort: AbortController,
  ): AsyncIterable<LoginEvent> & { close: () => void } {
    const url = this.url(`/v1/auth/login/${sessionId}/events`);
    const headers = this.headers({ Accept: "text/event-stream" });

    let resolver: ((v: IteratorResult<LoginEvent>) => void) | null = null;
    const queue: LoginEvent[] = [];
    let done = false;

    const push = (ev: LoginEvent): void => {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r({ value: ev, done: false });
        return;
      }
      queue.push(ev);
    };
    const end = (): void => {
      if (done) return;
      done = true;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r({ value: undefined, done: true });
      }
    };

    (async () => {
      try {
        const res = await fetch(url, { method: "GET", headers, signal: abort.signal });
        if (!res.ok || res.body === null) {
          push({ type: "error", message: `HTTP ${res.status}` });
          end();
          return;
        }
        const reader = res.body
          .pipeThrough(
            new TextDecoderStream() as unknown as ReadableWritablePair<
              string,
              Uint8Array
            >,
          )
          .getReader();
        let buf = "";
        let currentData: string[] = [];
        while (!abort.signal.aborted) {
          const { value, done: rdone } = await reader.read();
          if (rdone) break;
          buf += value;
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.length === 0) {
              if (currentData.length > 0) {
                try {
                  const ev = JSON.parse(currentData.join("\n")) as LoginEvent;
                  push(ev);
                } catch {
                  // skip malformed
                }
                currentData = [];
              }
            } else if (!line.startsWith(":")) {
              const colon = line.indexOf(":");
              const field = colon === -1 ? line : line.slice(0, colon);
              const val =
                colon === -1
                  ? ""
                  : line.slice(colon + 1).startsWith(" ")
                    ? line.slice(colon + 2)
                    : line.slice(colon + 1);
              if (field === "data") currentData.push(val);
            }
            nl = buf.indexOf("\n");
          }
        }
        end();
      } catch (err) {
        if (!abort.signal.aborted) {
          push({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        end();
      }
    })();

    return {
      [Symbol.asyncIterator](): AsyncIterator<LoginEvent> {
        return {
          next(): Promise<IteratorResult<LoginEvent>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift() as LoginEvent, done: false });
            }
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<LoginEvent>>((resolve) => {
              resolver = resolve;
            });
          },
          return(): Promise<IteratorResult<LoginEvent>> {
            abort.abort();
            end();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
      close(): void {
        abort.abort();
        end();
      },
    };
  }
}
