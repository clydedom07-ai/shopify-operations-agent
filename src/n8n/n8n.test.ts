import { describe, it, expect, afterEach } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";
import { PermissionResolver } from "../domain/permissions.ts";
import type { ActionRecord, StructuredResult, Task } from "../domain/types.ts";
import { ShopifyToolProvider } from "../tools/shopify/provider.ts";
import { MockShopifyClient } from "../tools/shopify/mockClient.ts";
import { InternalToolProvider } from "../tools/internal/provider.ts";
import { BusinessToolProvider } from "../tools/business/provider.ts";
import { SupplierToolProvider } from "../tools/supplier/provider.ts";
import { MockSupplierDirectory } from "../supplier/mockDirectory.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ScriptedLlmGateway } from "../llm/scriptedGateway.ts";
import { AgentTaskRunner } from "../agent/runner.ts";
import { createLogger } from "../lib/logger.ts";
import { MockN8nWebhookClient } from "./mockClient.ts";
import { HttpN8nWebhookClient } from "./httpClient.ts";
import { buildN8nCallbackPayload, type N8nCallbackPayload } from "./types.ts";
import { n8nCallbackTaskCompletion } from "./callback.ts";

const logger = createLogger("silent");

function sampleResult(overrides: Partial<StructuredResult> = {}): StructuredResult {
  return {
    status: "resolved",
    summary: "Order #1001 is on track; shipment scheduled next week.",
    intent: "Update the customer about their order.",
    priority: "medium",
    confidence: "INFORMATIONAL ONLY",
    findings: [
      {
        id: "f-1",
        kind: "shipment",
        title: "Shipment on schedule",
        detail: "Carrier update shows the parcel will move on schedule.",
        source: "orders/1001/fulfillments",
        severity: "info",
      },
    ],
    actions: [
      {
        actionKind: "add_order_note",
        tool: "business_addOrderNote",
        mode: "auto",
        outcome: "performed",
        detail: "Note added to order #1001.",
        at: "2026-09-15T10:00:00.000Z",
      },
    ],
    recommendedActions: [],
    requiresHumanApproval: false,
    ...overrides,
  };
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  const now = "2026-09-15T10:00:00.000Z";
  return {
    id: "n8n-task-complete",
    type: "investigate-order",
    status: "succeeded",
    input: { text: "Where is order #1001?", orderId: "1001", customerEmail: "ava@example.com" },
    priority: "medium",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: "2026-09-15T10:05:00.000Z",
    currentStep: "done",
    ...overrides,
  };
}

const openServers: Server[] = [];
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
});

/** Real local HTTP server on a random port, for the fetch-based client. */
function startServer(handler: http.RequestListener): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/webhook/abc`, server });
    });
  });
}

describe("n8n/buildN8nCallbackPayload", () => {
  it("derives the payload strictly from the task and recorded result", () => {
    const result = sampleResult();
    const task = sampleTask();
    const payload = buildN8nCallbackPayload(task, result);

    expect(payload.event).toBe("task_completed");
    expect(payload.taskId).toBe("n8n-task-complete");
    expect(payload.taskType).toBe("investigate-order");
    expect(payload.status).toBe("resolved");
    expect(payload.summary).toContain("#1001");
    expect(payload.priority).toBe("medium");
    expect(payload.requiresHumanApproval).toBe(false);
    expect(payload.completedAt).toBe("2026-09-15T10:05:00.000Z");

    // Actions and findings mirror the recorded ground truth
    expect(payload.actions).toEqual([{ actionKind: "add_order_note", outcome: "performed" }]);
    expect(payload.findings).toEqual([
      { kind: "shipment", severity: "info", title: "Shipment on schedule" },
    ]);
    // No pending approval was recorded, so none is surfaced
    expect(payload.pendingApprovals).toEqual([]);
  });

  it("surfaces pending approvals and escalation from the recorded actions", () => {
    const approval: ActionRecord = {
      actionKind: "refund",
      tool: "business_refund",
      mode: "approval",
      outcome: "needs_approval",
      detail: "apr-refund-1001",
      at: "2026-09-15T10:01:00.000Z",
    };
    const result = sampleResult({
      status: "needs_approval",
      requiresHumanApproval: true,
      escalationReason: "Refund above the auto-refund threshold.",
      actions: [approval],
    });
    const payload = buildN8nCallbackPayload(sampleTask(), result) as N8nCallbackPayload;

    expect(payload.status).toBe("needs_approval");
    expect(payload.requiresHumanApproval).toBe(true);
    expect(payload.escalationReason).toContain("threshold");
    expect(payload.pendingApprovals).toEqual([{ id: "apr-refund-1001", actionKind: "refund" }]);
  });
});

describe("n8n/mockClient", () => {
  it("records the callback and reports success", async () => {
    const client = new MockN8nWebhookClient();
    const outcome = await client.notify({ event: "task_completed", taskId: "t" });
    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.taskId).toBe("t");
  });

  it("surfaces a forced failure without throwing", async () => {
    const client = new MockN8nWebhookClient(true);
    const outcome = await client.notify({});
    expect(outcome.ok).toBe(false);
    expect(client.sent).toHaveLength(1);
  });
});

describe("n8n/httpClient", () => {
  it("POSTs the JSON payload and reports the response status", async () => {
    let received: { body?: unknown; type?: string } = {};
    const { url } = await startServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received = { body: JSON.parse(data), type: req.headers["content-type"] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ started: true }));
      });
    });

    const client = new HttpN8nWebhookClient(url);
    const outcome = await client.notify({ event: "task_completed", taskId: "t-9" });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(received.type).toContain("application/json");
    expect(received.body).toMatchObject({ event: "task_completed", taskId: "t-9" });
  });

  it("reports a non-2xx webhook response as a failure", async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });

    const outcome = await new HttpN8nWebhookClient(url).notify({});
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(500);
    expect(outcome.error).toContain("500");
  });

  it("aborts a hanging webhook after the timeout", async () => {
    // Server never responds; the client must give up on its own.
    const { url } = await startServer((_req, _res) => {
      /* intentionally never respond */
    });

    const client = new HttpN8nWebhookClient(url, 50);
    const started = Date.now();
    const outcome = await client.notify({});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("n8n/n8nCallbackTaskCompletion", () => {
  it("builds a truth-derived payload, delivers it, and logs success", async () => {
    const client = new MockN8nWebhookClient();
    const outcome = await n8nCallbackTaskCompletion(sampleTask(), sampleResult(), { client, logger });

    expect(outcome.ok).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({ event: "task_completed", taskId: "n8n-task-complete" });
  });

  it("never throws on a failed webhook — it returns the failure", async () => {
    const client = new MockN8nWebhookClient(true);
    const outcome = await n8nCallbackTaskCompletion(sampleTask(), sampleResult(), { client, logger });
    expect(outcome.ok).toBe(false);
  });
});

describe("n8n/runner onTaskComplete hook", () => {
  it("fires the callback after a task succeeds without failing the task", async () => {
    const repo = new InMemoryRepository();
    const registry = new ToolRegistry(logger, new PermissionResolver())
      .register(new ShopifyToolProvider(new MockShopifyClient()))
      .register(new SupplierToolProvider(new MockSupplierDirectory()))
      .register(new InternalToolProvider())
      .register(new BusinessToolProvider());
    const gateway = new ScriptedLlmGateway(logger);
    const client = new MockN8nWebhookClient();
    const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger, {
      claimIntervalMs: 5,
      onTaskComplete: async (task, result) => {
        await n8nCallbackTaskCompletion(task, result, { client, logger });
      },
    });

    const task = await repo.createTask(
      { type: "investigate-order", input: { text: "Where is order #1001?", orderId: "ord_1001" } },
      "n8n-hook-task",
    );
    await runner.run(task);
    const stored = (await repo.getTask("n8n-hook-task"))!;

    expect(stored.status).toBe("succeeded");
    expect(stored.result?.status).toBe("resolved");
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      event: "task_completed",
      taskId: "n8n-hook-task",
      status: "resolved",
    });
  });

  it("keeps the task succeeded even when the callback itself throws", async () => {
    const repo = new InMemoryRepository();
    const registry = new ToolRegistry(logger, new PermissionResolver())
      .register(new ShopifyToolProvider(new MockShopifyClient()))
      .register(new SupplierToolProvider(new MockSupplierDirectory()))
      .register(new InternalToolProvider())
      .register(new BusinessToolProvider());
    const gateway = new ScriptedLlmGateway(logger);
    const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger, {
      claimIntervalMs: 5,
      onTaskComplete: async () => {
        throw new Error("webhook exploded");
      },
    });

    const task = await repo.createTask(
      { type: "investigate-order", input: { text: "Where is order #1001?", orderId: "ord_1001" } },
      "n8n-hook-throw",
    );
    await runner.run(task);
    const stored = (await repo.getTask("n8n-hook-throw"))!;

    // A downstream webhook failure must never bounce a succeeded task to failed.
    expect(stored.status).toBe("succeeded");
    expect(stored.error).toBeUndefined();
  });
});