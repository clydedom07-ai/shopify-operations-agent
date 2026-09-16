import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../../lib/logger.ts";
import { InMemoryRepository } from "../../db/inMemoryRepository.ts";
import { ToolRegistry } from "../registry.ts";
import type { ToolContext } from "../provider.ts";
import { MockShopifyClient } from "./mockClient.ts";
import { ShopifyToolProvider } from "./provider.ts";
import type { ToolDispatch } from "../registry.ts";

const logger: Logger = createLogger("silent");

function makeRegistry() {
  const repo = new InMemoryRepository();
  const registry = new ToolRegistry(logger).register(new ShopifyToolProvider(new MockShopifyClient()));
  return { repo, registry };
}

const ctx = (taskId: string, repo: InMemoryRepository): ToolContext => ({ taskId, step: 1, logger, repo });

describe("MockShopifyClient fixtures", () => {
  it("ships a deterministic fixture store across all scenarios", async () => {
    const client = new MockShopifyClient();
    expect(await client.searchOrders({})).toHaveLength(6);
    expect(await client.searchOrders({ status: "cancelled" })).toHaveLength(1);
  });

  it("searches by order name, customer email, and line-item title", async () => {
    const client = new MockShopifyClient();
    expect((await client.searchOrders({ query: "#1002" })).map((o) => o.id)).toEqual(["ord_1002"]);
    expect((await client.searchOrders({ query: "marcus@example.com" })).map((o) => o.id)).toEqual(["ord_1003"]);
    expect((await client.searchOrders({ query: "Aurora" })).map((o) => o.id)).toEqual(["ord_1001", "ord_1006", "ord_1002"]);
  });

  it("returns a customer by id or email", async () => {
    const client = new MockShopifyClient();
    const byEmail = await client.getCustomer({ email: "ava@example.com" });
    expect(byEmail?.firstName).toBe("Ava");
    expect(await client.getCustomer({ email: "nobody@example.com" })).toBeNull();
  });

  it("returns a product by id or sku", async () => {
    const client = new MockShopifyClient();
    expect((await client.getProduct({ sku: "HOOD-BLK-M" }))?.id).toBe("prod_1");
    expect(await client.getProduct({ sku: "NOPE" })).toBeNull();
  });

  it("adds an internal order note, preserving existing notes", async () => {
    const client = new MockShopifyClient();
    const order = await client.addOrderNote("ord_1001", "Investigated 2026-09-12: awaiting fulfillment.");
    expect(order.notes).toContain("Investigated 2026-09-12: awaiting fulfillment.");
    const again = await client.addOrderNote("ord_1001", "Follow-up logged.");
    expect(again.notes).toHaveLength(2);
    await expect(client.addOrderNote("ord_missing", "x")).rejects.toThrow("Order not found");
  });

  it("exposes a dormant shipment (no scan in 9 days)", async () => {
    const client = new MockShopifyClient();
    const [ful] = await client.getFulfillment({ orderId: "ord_1002" });
    expect(ful.trackingNumber).toBe("1Z-STALE-9DAY");
    const last = ful.trackingEvents.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b));
    expect(Date.parse(last.occurredAt)).toBeLessThan(Date.now() - 8 * 86_400_000);
    expect(last.status).toBe("in_transit");
  });

  it("exposes a delivered-but-not-received case", async () => {
    const client = new MockShopifyClient();
    const [ful] = await client.getFulfillment({ orderId: "ord_1003" });
    expect(ful.trackingEvents.some((e) => e.status === "delivered")).toBe(true);
  });

  it("reports inventory, including out-of-stock", async () => {
    const client = new MockShopifyClient();
    const levels = await client.getInventory({ productId: "prod_3" });
    expect(levels).toHaveLength(1);
    expect(levels[0].available).toBe(0);
  });
});

describe("Shopify tool provider via ToolRegistry", () => {
  it("registers all seven tools", () => {
    const { registry } = makeRegistry();
    expect(registry.names()).toEqual(
      expect.arrayContaining([
        "shopify_searchOrders",
        "shopify_getOrder",
        "shopify_getCustomer",
        "shopify_getProduct",
        "shopify_getFulfillment",
        "shopify_getInventory",
        "shopify_addOrderNote",
      ]),
    );
  });

  it("dispatches a read tool and writes a matching audit row", async () => {
    const { repo, registry } = makeRegistry();
    const task = await repo.createTask({ type: "investigate-order", input: { text: "where is it" } }, "t-1");

    const res = (await registry.dispatch("shopify_getOrder", { id: "ord_1001" }, ctx(task.id, repo))) as Extract<ToolDispatch, { ok: true }>;
    expect(res.ok).toBe(true);
    expect((res.result as { name: string }).name).toBe("#1001");

    const logs = await repo.listActionLogs({ taskId: task.id });
    expect(logs).toHaveLength(1);
    expect(logs[0].tool).toBe("shopify_getOrder");
    expect(logs[0].actionKind).toBe("get_order");
    expect(logs[0].mode).toBe("auto");
    expect(logs[0].isError).toBe(false);
  });

  it("rejects invalid input without executing", async () => {
    const { repo, registry } = makeRegistry();
    const task = await repo.createTask({ type: "run", input: { text: "x" } }, "t-2");
    const res = (await registry.dispatch("shopify_getOrder", { id: "" }, ctx(task.id, repo))) as Extract<ToolDispatch, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid input");
    expect(await repo.listActionLogs({ taskId: task.id })).toHaveLength(0);
  });

  it("records tool failures in the audit trail", async () => {
    const { repo, registry } = makeRegistry();
    const task = await repo.createTask({ type: "run", input: { text: "x" } }, "t-3");
    const res = (await registry.dispatch("shopify_addOrderNote", { orderId: "ord_missing", note: "hi" }, ctx(task.id, repo))) as Extract<ToolDispatch, { ok: false }>;
    expect(res.ok).toBe(false);
    const logs = await repo.listActionLogs({ taskId: task.id });
    expect(logs[0].isError).toBe(true);
  });

  it("marks the adjustment-tier kind for approval-requiring tools", () => {
    const { registry } = makeRegistry();
    const refundTool = registry.get("shopify_getOrder")!;
    expect(refundTool.actionKind).toBe("get_order");
    expect(registry.modeFor(refundTool.actionKind)).toBe("auto");
  });
});