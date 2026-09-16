import type { RestClient, RestMethod, RestRequest, RestResponse } from "./types.ts";

/**
 * A canned route the mock replies with. Paths match exactly (the query string
 * is ignored), so the tool and tests are deterministic.
 */
export interface MockRestRoute {
  method: RestMethod;
  path: string;
  status: number;
  body?: unknown;
}

/**
 * Deterministic, network-free REST client for dev and tests. Records every call,
 * answers from a route table, and reports an unrouted path as a 404 failure —
 * so an unmocked call is surfaced as not-ok, never fabricated as a success.
 * `failNext` forces a transport failure so the error path is exercisable.
 */
export class MockRestClient implements RestClient {
  readonly id = "mock";
  readonly calls: RestRequest[] = [];
  private readonly routes: MockRestRoute[];
  private readonly failNext: boolean;

  constructor(routes: MockRestRoute[] = [], opts: { failNext?: boolean } = {}) {
    this.routes = routes;
    this.failNext = opts.failNext ?? false;
  }

  async request(req: RestRequest): Promise<RestResponse> {
    this.calls.push(req);
    if (this.failNext) return { ok: false, status: 0, error: "mock rest transport failure" };
    const route = this.routes.find((r) => r.method === req.method && r.path === req.path);
    if (!route) {
      return { ok: false, status: 404, body: { error: "not_found" }, error: `mock: no route for ${req.method} ${req.path}` };
    }
    const ok = route.status >= 200 && route.status < 300;
    return ok
      ? { ok: true, status: route.status, body: route.body }
      : { ok: false, status: route.status, body: route.body, error: `mock: HTTP ${route.status}` };
  }
}