import { describe, it, expect, afterEach } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpShopifyClient } from "./httpClient.ts";

const openServers: Server[] = [];
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
});

/**
 * Boot a fixture Admin API server and a client pointed at it. The server
 * records the method, path, and auth header of every request so tests can
 * assert the client's exact wire behavior.
 */
function boot(
  handler: http.RequestListener,
  token = "shpat_fixture",
): Promise<{
  client: HttpShopifyClient;
  url: string;
  seen: Array<{ method: string; path: string; auth: string | undefined }>;
}> {
  const seen: Array<{ method: string; path: string; auth: string | undefined }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers["x-shopify-access-token"] as string | undefined });
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      // Pass the fixture base as the "store" to prove full-URL stores work; the
      // client appends /admin/api/<version>.
      resolve({ client: new HttpShopifyClient(url, token, "2024-10"), url, seen });
    });
  });
}

const orderJson = {
  id: 9001,
  name: "#1001",
  email: "ava@example.com",
  status: "open",
  financial_status: "paid",
  fulfillment_status: "unfulfilled",
  total_price: "78.00",
  currency: "USD",
  created_at: "2026-09-14T10:00:00Z",
  updated_at: "2026-09-14T10:00:00Z",
  note: "First note\nSecond note",
  line_items: [
    { id: 101, title: "Aurora Hoodie", sku: "HOOD-BLK-M", quantity: 1, product_id: 501 },
  ],
};

describe("shopify/httpClient", () => {
  it("sends the Admin access token and versioned base on every request", async () => {
    const { client, seen } = await boot((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await client.searchOrders({ status: "open" });
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe("shpat_fixture");
    expect(seen[0].path).toBe("/admin/api/2024-10/orders.json?status=open");
  });

  it("searchOrders forwards status, query, and limit and maps snake_case to domain", async () => {
    let capturedPath = "";
    const { client } = await boot((req, res) => {
      capturedPath = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [orderJson] }));
    });
    const orders = await client.searchOrders({ status: "open", query: "ava", limit: 5 });
    expect(capturedPath).toBe("/admin/api/2024-10/orders.json?status=open&query=ava&limit=5");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: "9001",
      name: "#1001",
      email: "ava@example.com",
      status: "open",
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      totalPrice: "78.00",
      notes: ["First note", "Second note"], // single REST note field → array
      lineItems: [{ id: "101", title: "Aurora Hoodie", sku: "HOOD-BLK-M", quantity: 1, productId: "501" }],
    });
  });

  it("searchOrders reports a non-2xx as an honest empty list, never a fabricated order", async () => {
    const { client } = await boot((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const orders = await client.searchOrders({});
    expect(orders).toEqual([]);
  });

  it("getOrder maps the payload; a 404 returns null, never a crash", async () => {
    const { client } = await boot((req, res) => {
      if (req.url!.includes("/orders/nope")) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ order: orderJson }));
    });
    const found = await client.getOrder("9001");
    expect(found?.name).toBe("#1001");
    expect(found?.id).toBe("9001");

    // A 404 from the API is "unknown order", not a crash.
    expect(await client.getOrder("nope")).toBeNull();
  });

  it("getCustomer resolves by id and by email search", async () => {
    const customerJson = { id: 42, first_name: "Ava", last_name: "Chen", email: "ava@example.com", orders_count: 3, total_spent: "214.00" };
    const paths: string[] = [];
    const { client } = await boot((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url!.includes("/customers/search.json")) {
        res.end(JSON.stringify({ customers: [customerJson] }));
      } else {
        res.end(JSON.stringify({ customer: customerJson }));
      }
    });
    const byId = await client.getCustomer({ id: "42" });
    expect(byId).toMatchObject({ id: "42", firstName: "Ava", totalSpent: "214.00" });
    const byEmail = await client.getCustomer({ email: "ava@example.com" });
    expect(byEmail?.email).toBe("ava@example.com");
    // Email search uses Shopify's email: filter syntax.
    expect(paths[1]).toBe("/admin/api/2024-10/customers/search.json?query=email%3Aava%40example.com");
  });

  it("getProduct maps tags (comma string → array) and finds by SKU via the listing", async () => {
    const productJson = {
      id: 501, title: "Aurora Hoodie", handle: "aurora-hoodie", status: "active",
      tags: "apparel, winter", // REST: comma-separated string
      variants: [{ id: 601, title: "Black / M", sku: "HOOD-BLK-M", inventory_item_id: "inv_1" }],
    };
    const paths: string[] = [];
    const { client } = await boot((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url!.includes("/products.json?")) {
        res.end(JSON.stringify({ products: [productJson] }));
      } else {
        res.end(JSON.stringify({ product: productJson }));
      }
    });
    const byId = await client.getProduct({ id: "501" });
    expect(byId?.tags).toEqual(["apparel", "winter"]);
    expect(byId?.variants[0].inventoryItemId).toBe("inv_1");

    const bySku = await client.getProduct({ sku: "HOOD-BLK-M" });
    expect(bySku?.id).toBe("501");
    expect(paths[1]).toBe("/admin/api/2024-10/products.json?limit=250&fields=id,title,handle,status,tags,variants");
  });

  it("getProduct reports an unknown SKU in the first 250 as null — never a guess", async () => {
    const { client } = await boot((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ products: [] }));
    });
    expect(await client.getProduct({ sku: "DOES-NOT-EXIST" })).toBeNull();
  });

  it("getFulfillment lists by orderId and maps tracking events; a bare fulfillment id returns [] honestly", async () => {
    const fulfillmentJson = {
      id: 701, order_id: 9002, status: "in_transit",
      tracking_company: "Falcon Parcel", tracking_number: "1Z-FRESH", tracking_url: "https://track.example/1Z",
      created_at: "2026-09-15T09:00:00Z",
      tracking_events: [
        { status: "info_received", location: null, occurred_at: "2026-09-14T09:00:00Z" },
        { status: "in_transit", location: "Newark, NJ", occurred_at: "2026-09-16T09:00:00Z" },
      ],
    };
    const paths: string[] = [];
    const { client } = await boot((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fulfillments: [fulfillmentJson] }));
    });
    const rows = await client.getFulfillment({ orderId: "9002" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "701",
      orderId: "9002",
      trackingCompany: "Falcon Parcel",
      trackingEvents: [
        { status: "info_received", location: null },
        { status: "in_transit", location: "Newark, NJ" },
      ],
    });
    expect(paths[0]).toBe("/admin/api/2024-10/orders/9002/fulfillments.json");

    // Admin REST has no global fulfillments listing — resolve nothing honestly.
    expect(await client.getFulfillment({ fulfillmentId: "701" })).toEqual([]);
  });

  it("getInventory resolves productId → variant inventory item ids, or filters by item id", async () => {
    const inventoryJson = { inventory_item_id: "inv_1", location_id: "loc_1", available: 12 };
    const paths: string[] = [];
    const { client } = await boot((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url!.includes("/inventory_levels.json")) {
        res.end(JSON.stringify({ inventory_levels: [inventoryJson] }));
      } else {
        res.end(JSON.stringify({
          product: { id: 501, title: "Aurora Hoodie", handle: "x", status: "active", tags: "", variants: [{ id: 601, title: "M", sku: "S", inventory_item_id: "inv_1" }] },
        }));
      }
    });
    const byItem = await client.getInventory({ inventoryItemId: "inv_1" });
    expect(byItem).toEqual([{ inventoryItemId: "inv_1", locationId: "loc_1", available: 12 }]);
    expect(paths[0]).toBe("/admin/api/2024-10/inventory_levels.json?inventory_item_ids=inv_1");

    const byProduct = await client.getInventory({ productId: "501" });
    expect(byProduct[0]?.available).toBe(12);
    expect(paths[1]).toBe("/admin/api/2024-10/products/501.json");
    expect(paths[2]).toBe("/admin/api/2024-10/inventory_levels.json?inventory_item_ids=inv_1");
  });

  it("addOrderNote reads the current notes, appends, and PUTs the combined note back", async () => {
    let putBody: string | null = null;
    let putPath = "";
    const { client } = await boot((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "PUT") {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          putBody = data;
          putPath = req.url ?? "";
          res.end(JSON.stringify({ order: { ...orderJson, note: "First note\nSecond note\nLogged by agent" } }));
        });
        return;
      }
      res.end(JSON.stringify({ order: orderJson }));
    });
    const updated = await client.addOrderNote("9001", "Logged by agent");
    expect(putPath).toBe("/admin/api/2024-10/orders/9001.json");
    const parsed = JSON.parse(putBody!);
    expect(parsed.order.note).toBe("First note\nSecond note\nLogged by agent");
    // The returned order has the note back as domain shape.
    expect(updated.notes).toContain("Logged by agent");
  });

  it("addOrderNote throws when the write fails, so the registry audits it as an error", async () => {
    const { client } = await boot((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ order: orderJson }));
        return;
      }
      res.writeHead(400);
      res.end();
    });
    await expect(client.addOrderNote("9001", "Logged by agent")).rejects.toThrow(/400/);
  });

  it("aborts a hanging backend after the timeout and answers null, never a crash", async () => {
    const { url } = await boot(() => {
      /* intentionally never respond */
    });
    const started = Date.now();
    const orders = await new HttpShopifyClient(url, "t", "2024-10", 50).searchOrders({});
    expect(orders).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});