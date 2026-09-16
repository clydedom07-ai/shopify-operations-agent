import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/logger.ts";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";
import { PermissionResolver } from "../domain/permissions.ts";
import { MockShopifyClient } from "../tools/shopify/mockClient.ts";
import { ShopifyToolProvider } from "../tools/shopify/provider.ts";
import { InternalToolProvider } from "../tools/internal/provider.ts";
import { BusinessToolProvider } from "../tools/business/provider.ts";
import { SupplierToolProvider } from "../tools/supplier/provider.ts";
import { MockSupplierDirectory } from "../supplier/mockDirectory.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ScriptedLlmGateway } from "../llm/scriptedGateway.ts";
import { AgentTaskRunner } from "../agent/runner.ts";
import { buildApiServer } from "./server.ts";

const logger = createLogger("silent");
const TOKEN = "test-token";

function makeApi() {
  const repo = new InMemoryRepository();
  const registry = new ToolRegistry(logger, new PermissionResolver())
    .register(new ShopifyToolProvider(new MockShopifyClient()))
    .register(new SupplierToolProvider(new MockSupplierDirectory()))
    .register(new InternalToolProvider())
    .register(new BusinessToolProvider());
  const gateway = new ScriptedLlmGateway(logger);
  const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger, { claimIntervalMs: 5 });
  const app = buildApiServer({ repo, registry, logger, apiAuthToken: TOKEN, persistence: "memory" });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const drain = async () => runner.drainPending();
  return { app, repo, runner, auth, drain };
}

type Api = ReturnType<typeof makeApi>;

/** Enqueue then drain until the task finishes; returns the task from the repo. */
async function runViaApi(api: Api, url: string, payload: Record<string, unknown>) {
  const created = await api.app.inject({ method: "POST", url, headers: api.auth, payload });
  expect(created.statusCode).toBe(201);
  const { taskId } = created.json<{ taskId: string }>();
  expect(taskId).toBeTruthy();
  await api.drain();
  const task = await api.repo.getTask(taskId);
  expect(task?.status).toBe("succeeded");
  return task!;
}

describe("api — auth and health", () => {
  it("GET /health is unauthenticated and reports ok", async () => {
    const { app } = makeApi();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "shopify-operations-agent", persistence: "memory" });
  });

  it("rejects missing or wrong bearer token with 401", async () => {
    const { app, auth } = makeApi();
    const noAuth = await app.inject({ method: "POST", url: "/agent/run", payload: { text: "hi" } });
    expect(noAuth.statusCode).toBe(401);
    const wrongAuth = await app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: `Bearer nope` },
      payload: { text: "hi" },
    });
    expect(wrongAuth.statusCode).toBe(401);
    expect(auth).toBeDefined();
  });

  it("rejects an invalid enqueue body with 400", async () => {
    const { app, auth } = makeApi();
    const res = await app.inject({ method: "POST", url: "/agent/run", headers: auth, payload: { orderId: "ord_1001" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_body");
  });
});

describe("api — enqueue → worker → results", () => {
  it("customer-email (#1001): enqueued, event recorded, resolved honestly with no invented delivery date", async () => {
    const api = makeApi();
    const task = await runViaApi(api, "/agent/customer-email", {
      text: "Where is my order?",
      orderId: "ord_1001",
    });
    expect(task.result?.status).toBe("resolved");
    expect(task.result?.requiresHumanApproval).toBe(false);
    expect(task.result?.actions.some((a) => a.tool === "shopify_getOrder" && a.outcome === "performed")).toBe(true);
    expect(task.result?.summary).toMatch(/fulfil/);
    expect(task.result?.summary).not.toMatch(/1Z-|delivered|will (arrive|be delivered)/i);

    const events = await api.repo.listEvents();
    expect(events.some((e) => e.type === "customer_email_received" && e.source === "api")).toBe(true);
  });

  it("slack-message: enqueued, slack_message_received recorded, resolves honestly", async () => {
    const api = makeApi();
    const task = await runViaApi(api, "/agent/slack-message", {
      text: "Hey, I ordered #1001 over a week ago and haven't heard anything.",
    });
    expect(task.type).toBe("slack-message");
    expect(task.result?.status).toBe("resolved");
    expect(task.result?.summary).toContain("#1001");
    expect(task.result?.summary).not.toMatch(/1Z-|delivered|will (arrive|be delivered)/i);

    const events = await api.repo.listEvents();
    expect(events.some((e) => e.type === "slack_message_received" && e.source === "api")).toBe(true);
  });

  it("investigate-order (#1002): dormant shipment audited, issue surfaced via GET /agent/issues", async () => {
    const api = makeApi();
    const task = await runViaApi(api, "/agent/investigate-order", {
      text: "No tracking update for a while.",
      orderId: "ord_1002",
    });
    expect(task.result?.status).toBe("resolved");
    expect(task.result?.actions.map((a) => a.tool)).toContain("internal_createIssue");

    const issues = await api.app.inject({ method: "GET", url: "/agent/issues", headers: api.auth });
    expect(issues.statusCode).toBe(200);
    expect(issues.json<{ issues: Array<{ kind: string; title: string }> }>().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "shipment", title: "Dormant shipment" })]),
    );

    const actions = await api.app.inject({ method: "GET", url: `/agent/actions?taskId=${task.id}`, headers: api.auth });
    const list = actions.json<{ actions: Array<{ tool: string; actionKind: string }> }>().actions;
    expect(list.some((a) => a.tool === "shopify_getFulfillment" && a.actionKind === "get_fulfillment")).toBe(true);
  });

  it("customer-email (#1003 delivered-not-received): needs_approval, approval listed as pending", async () => {
    const api = makeApi();
    const task = await runViaApi(api, "/agent/customer-email", {
      text: "Tracking says delivered but I never received it.",
      orderId: "ord_1003",
    });
    expect(task.result?.status).toBe("needs_approval");
    expect(task.result?.requiresHumanApproval).toBe(true);
    expect(task.result?.actions.some((a) => a.tool === "business_sendCustomerEmail" && a.outcome === "needs_approval")).toBe(true);

    const approvals = await api.app.inject({ method: "GET", url: "/agent/approvals?status=pending", headers: api.auth });
    const list = approvals.json<{ approvals: Array<{ actionKind: string; status: string }> }>().approvals;
    expect(list).toEqual([expect.objectContaining({ actionKind: "send_customer_email", status: "pending" })]);
  });

  it("detect-issues (#1004): stuck order files a critical issue proactively", async () => {
    const api = makeApi();
    const task = await runViaApi(api, "/agent/detect-issues", {
      text: "Scheduled operations check.",
      orderId: "ord_1004",
    });
    expect(task.result?.status).toBe("resolved");
    expect(task.result?.findings.some((f) => f.severity === "critical")).toBe(true);
    const issues = await api.repo.listIssues();
    expect(issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("run with explicit eventType records that event and reaches needs_info for unlocated orders", async () => {
    const api = makeApi();
    const created = await api.app.inject({
      method: "POST",
      url: "/agent/run",
      headers: api.auth,
      payload: { text: "I can't find my order number.", eventType: "manual_investigation" },
    });
    expect(created.statusCode).toBe(201);
    const { taskId } = created.json<{ taskId: string }>();
    await api.drain();
    const task = await api.repo.getTask(taskId);
    expect(task?.status).toBe("succeeded");
    expect(task?.result?.status).toBe("needs_info");
    expect(task?.result?.escalationReason).toBeTruthy();
    const events = await api.repo.listEvents();
    expect(events.some((e) => e.type === "manual_investigation")).toBe(true);
  });

  it("GET /agent/tasks/:id 404s for an unknown task", async () => {
    const { app, auth } = makeApi();
    const res = await app.inject({ method: "GET", url: "/agent/tasks/does-not-exist", headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

describe("api — human-in-the-loop approvals", () => {
  async function pendingApproval() {
    const api = makeApi();
    await runViaApi(api, "/agent/customer-email", {
      text: "Delivered but not received.",
      orderId: "ord_1003",
    });
    const approvals = await api.repo.listApprovals({ status: "pending" });
    return { api, approval: approvals[0]! };
  }

  it("approval decision executes the tool only after approve — and honestly reports the refusal", async () => {
    const { api, approval } = await pendingApproval();
    const res = await api.app.inject({
      method: "POST",
      url: `/agent/approvals/${approval.id}/decide`,
      headers: api.auth,
      payload: { decision: "approved", actor: "ops-lead", reason: "Customer confirmed courier issue" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ approvalId: approval.id, status: "approved", executed: false, outcome: "refused" });
    // No live business integration exists yet, so the approved tool was attempted
    // and refused — the response must say so rather than claim it ran.
    expect(body.refusal).toMatch(/live business-system integration/);

    const after = await api.repo.getApproval(approval.id);
    expect(after?.status).toBe("approved");
    expect(after?.decidedBy).toBe("ops-lead");

    const logs = await api.repo.listActionLogs({ taskId: approval.taskId });
    const decisionRow = logs.find((l) => l.output && typeof l.output === "object" && (l.output as { executed?: boolean }).executed === false);
    expect(decisionRow?.output).toMatchObject({ outcome: "refused", executed: false, decision: "approved" });
  });

  it("rejection records the decision and never executes", async () => {
    const { api, approval } = await pendingApproval();
    const res = await api.app.inject({
      method: "POST",
      url: `/agent/approvals/${approval.id}/decide`,
      headers: api.auth,
      payload: { decision: "rejected", actor: "ops-lead", reason: "Carrier claim shows signed delivery" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; executed: boolean; outcome: string }>();
    expect(body).toMatchObject({ status: "rejected", executed: false, outcome: "not_executed" });
    expect((await api.repo.getApproval(approval.id))?.status).toBe("rejected");
  });

  it("a decided approval cannot be decided again (409)", async () => {
    const { api, approval } = await pendingApproval();
    const first = await api.app.inject({
      method: "POST",
      url: `/agent/approvals/${approval.id}/decide`,
      headers: api.auth,
      payload: { decision: "approved" },
    });
    expect(first.statusCode).toBe(200);
    const second = await api.app.inject({
      method: "POST",
      url: `/agent/approvals/${approval.id}/decide`,
      headers: api.auth,
      payload: { decision: "rejected" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("unknown approval id returns 404", async () => {
    const { app, auth } = makeApi();
    const res = await app.inject({
      method: "POST",
      url: "/agent/approvals/nope/decide",
      headers: auth,
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(404);
  });
});