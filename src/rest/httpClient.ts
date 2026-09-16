import type { RestClient, RestRequest, RestResponse } from "./types.ts";

/**
 * Real REST client: resolves `req.path` against an operator-configured base URL
 * and fetches it. A fixed base origin is itself the guard — the agent cannot
 * reach arbitrary hosts. The origin check below is defense-in-depth against a
 * crafted path escaping the base (e.g. `//attacker.example`); a short timeout
 * keeps a slow endpoint from stalling the agent loop. Failures are surfaced as
 * a result, never thrown, and the response is only `ok` on a 2xx.
 */
export class HttpRestClient implements RestClient {
  readonly id = "http";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async request(req: RestRequest): Promise<RestResponse> {
    const base = new URL(this.baseUrl);
    // A path that carries its own scheme or host (absolute URL or protocol-
    // relative) is an attempt to reach beyond the allowlisted origin — refuse
    // before any network I/O. The origin comparison below is the second layer.
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(req.path)) {
      return { ok: false, status: 0, error: `refused: '${req.path}' escapes the allowlisted origin ${base.origin}` };
    }
    let target: URL;
    try {
      target = new URL(req.path.startsWith("/") ? req.path : `/${req.path}`, this.baseUrl);
    } catch {
      return { ok: false, status: 0, error: `REST call failed: invalid path '${req.path}'` };
    }
    if (target.origin !== base.origin) {
      return { ok: false, status: 0, error: `refused: '${req.path}' escapes the allowlisted origin ${base.origin}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(target.toString(), {
        method: req.method,
        headers: { "content-type": "application/json", ...(req.headers ?? {}) },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return res.ok
        ? { ok: true, status: res.status, body }
        : { ok: false, status: res.status, body, error: `REST ${req.method} ${req.path} returned HTTP ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, error: `REST call failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}