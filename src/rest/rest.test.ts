import { describe, it, expect, afterEach } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MockRestClient, type MockRestRoute } from "./mockClient.ts";
import { HttpRestClient } from "./httpClient.ts";
import { RestToolProvider } from "../tools/rest/provider.ts";
import { PermissionResolver, DEFAULT_MODES } from "../domain/permissions.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createLogger } from "../lib/logger.ts";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";

const logger = createLogger("silent");

describe("rest/mockClient", () => {
  it("answers from a route table and records each call", async () => {
    const client = new MockRestClient([{ method: "GET", path: "/wms/orders/ord_1001", status: 200, body: { state: "shipped" } }]);
    const out = await client.request({ method: "GET", path: "/wms/orders/ord_1001" });
    expect(out).toMatchObject({ ok: true, status: 200, body: { state: "shipped" } });
    expect(client.calls).toEqual([{ method: "GET", path: "/wms/orders/ord_1001" }]);
  });

  it("reports an unrouted path as an honest 404 failure", async () => {
    const client = new MockRestClient([]);
    const out = await client.request({ method: "GET", path: "/wms/nope" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
    expect(out.error).toContain("no route");
  });

  it("reports a non-2xx route as a failure, never a success", async () => {
    const client = new MockRestClient([{ method: "GET", path: "/wms/orders/ord_1001", status: 503, body: { error: "down" } }]);
    const out = await client.request({ method: "GET", path: "/wms/orders/ord_1001" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("503");
    expect(out.body).toMatchObject({ error: "down" });
  });

  it("surfaces a forced transport failure", async () => {
    const client = new MockRestClient([], { failNext: true });
    const out = await client.request({ method: "GET", path: "/wms/orders/ord_1001" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
    expect(out.error).toBeTruthy();
  });
});

const openServers: Server[] = [];
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
});

function startServer(handler: http.RequestListener, base = "/services/x"): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}${base}` });
    });
  });
}

describe("rest/httpClient", () => {
  it("GETs a JSON resource against the base origin and parses the body", async () => {
    let seen: { method?: string; url?: string } = {};
    const { url } = await startServer((req, res) => {
      seen = { method: req.method, url: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "shipped" }));
    });

    const out = await new HttpRestClient(url).request({ method: "GET", path: "/orders/ord_1001" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ state: "shipped" });
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/orders/ord_1001");
  });

  it("sends a JSON body on a write and reports success", async () => {
    let received: { body?: string; type?: string } = {};
    const { url } = await startServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received = { body: data, type: req.headers["content-type"] };
        res.writeHead(204);
        res.end();
      });
    });

    const out = await new HttpRestClient(url).request({ method: "POST", path: "/flags/ord_1001", body: { flag: "review" } });
    expect(out.ok).toBe(true);
    expect(out.status).toBe(204);
    expect(received.type).toContain("application/json");
    expect(JSON.parse(received.body!)).toEqual({ flag: "review" });
  });

  it("reports a non-2xx response as a failure with the status", async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(400);
      res.end('{"error":"invalid"}');
    });

    const out = await new HttpRestClient(url).request({ method: "GET", path: "/orders/ord_1001" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.error).toContain("400");
    expect(out.body).toMatchObject({ error: "invalid" });
  });

  it("aborts a hanging endpoint after the timeout", async () => {
    const { url } = await startServer((_req, _res) => {
      /* intentionally never respond */
    });

    const started = Date.now();
    const out = await new HttpRestClient(url, 50).request({ method: "GET", path: "/orders/ord_1001" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
    expect(out.error).toContain("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a path that escapes the allowlisted origin", async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    const client = new HttpRestClient(url);
    // Absolute-URL and protocol-relative paths must never escape the base origin.
    for (const evil of ["https://attacker.example/x", "//attacker.example/x"]) {
      const out = await client.request({ method: "GET", path: evil });
      expect(out.ok).toBe(false);
      expect(out.status).toBe(0);
      expect(out.error).toContain("escapes");
    }
  });
});

describe("rest/restToolProvider", () => {
  function makeRegistry(routes: MockRestRoute[] = []) {
    const client = new MockRestClient(routes);
    const registry = new ToolRegistry(logger, new PermissionResolver()).register(new RestToolProvider(client));
    return { registry, client };
  }

  function ctx(taskId = "t-rest") {
    return { taskId, step: 3, logger, repo: new InMemoryRepository() };
  }

  it("registers rest_get and rest_write; get is auto, write requires approval", () => {
    const { registry } = makeRegistry();
    expect(registry.names()).toEqual(["rest_get", "rest_write"]);
    expect(registry.modeFor("rest_http_get")).toBe("auto");
    expect(registry.modeFor("rest_http_write")).toBe("approval");
    expect(DEFAULT_MODES.rest_http_get).toBe("auto");
    expect(DEFAULT_MODES.rest_http_write).toBe("approval");
  });

  it("rest_get returns the honest resource on a 2xx", async () => {
    const { registry, client } = makeRegistry([{ method: "GET", path: "/wms/orders/ord_1001", status: 200, body: { state: "shipped" } }]);
    const out = await registry.dispatch("rest_get", { path: "/wms/orders/ord_1001" }, ctx());
    expect(out.ok).toBe(true);
    const result = out.ok ? out.result : null;
    expect(result).toMatchObject({ ok: true, status: 200, body: { state: "shipped" }, client: "mock" });
    expect(client.calls).toHaveLength(1);
  });

  it("rest_get reports a failed call as not-ok — never fabricates a success", async () => {
    const { registry } = makeRegistry([{ method: "GET", path: "/wms/orders/ord_1001", status: 503, body: { error: "down" } }]);
    const out = await registry.dispatch("rest_get", { path: "/wms/orders/ord_1001" }, ctx());
    expect(out.ok).toBe(true); // the tool itself ran without throwing
    expect(out.ok ? out.result : null).toMatchObject({ ok: false, status: 503 });
  });

  it("rest_write posts the method + body and reports delivery", async () => {
    const { registry, client } = makeRegistry([{ method: "POST", path: "/flags/ord_1001", status: 204 }]);
    const out = await registry.dispatch("rest_write", { method: "POST", path: "/flags/ord_1001", body: { flag: "review" } }, ctx());
    expect(out.ok).toBe(true);
    expect(out.ok ? out.result : null).toMatchObject({ ok: true, status: 204, client: "mock" });
    expect(client.calls).toEqual([{ method: "POST", path: "/flags/ord_1001", body: { flag: "review" } }]);
  });

  it("rejects a write with a read-unsafe method or a non-GET on the get tool", async () => {
    const { registry, client } = makeRegistry();
    const refused = await registry.dispatch("rest_get", { path: "/x" }, ctx());
    // No route → honest not-ok, never a fake success.
    expect(refused.ok).toBe(true);
    expect(refused.ok ? refused.result : null).toMatchObject({ ok: false, status: 404 });

    const badWrite = await registry.dispatch("rest_write", { method: "GET", path: "/x" }, ctx());
    // Schema rejected GET for a write tool — the client sees only the prior rest_get call.
    expect(badWrite.ok).toBe(false);
    expect(client.calls).toEqual([{ method: "GET", path: "/x" }]);
  });
});