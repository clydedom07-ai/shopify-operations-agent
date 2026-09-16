import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger, type Logger } from "../lib/logger.ts";
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
import type { LlmGateway, LlmRequest, LlmResponse, LlmToolUse } from "../llm/gateway.ts";
import type { ToolProvider } from "../tools/provider.ts";
import type { Task, TaskInput } from "../domain/types.ts";
import { runAgentTask } from "./core.ts";
import { AgentTaskRunner } from "./runner.ts";

const logger: Logger = createLogger("silent");

function makeContext(gateway?: LlmGateway) {
  const repo = new InMemoryRepository();
  const registry = new ToolRegistry(logger, new PermissionResolver())
    .register(new ShopifyToolProvider(new MockShopifyClient()))
    .register(new SupplierToolProvider(new MockSupplierDirectory()))
    .register(new InternalToolProvider())
    .register(new BusinessToolProvider());
  const deps = {
    registry,
    repo,
    logger,
    gateway: gateway ?? new ScriptedLlmGateway(logger),
  };
  return { repo, registry, gateway: deps.gateway, run: (input: { type: Task["type"]; input: TaskInput; priority?: Task["priority"] }) =>
    repo.createTask(input).then((task) => runAgentTask(task, deps).then((result) => ({ task, result }))) };
}

const FENCE = (env: unknown) => "```json\n" + JSON.stringify(env) + "\n```";

/** Test double: returns a scripted sequence of tool proposals, then a verdict. */
class SequenceGateway implements LlmGateway {
  readonly id = "sequence";
  private readonly proposals: LlmToolUse[][];
  private readonly verdict: LlmResponse;

  constructor(proposals: LlmToolUse[][], verdict: Record<string, unknown>) {
    this.proposals = proposals;
    this.verdict = {
      text: FENCE({
        status: "resolved",
        summary: "the double-gateway verdict",
        intent: "test",
        priority: "low",
        confidence: "high",
        findings: [],
        recommendedActions: [],
        requiresHumanApproval: false,
        escalationReason: undefined,
        ...verdict,
      }),
      toolUses: [],
    };
  }

  complete(_req: LlmRequest): Promise<LlmResponse> {
    const next = this.proposals.shift();
    return Promise.resolve(next ? { text: "", toolUses: next } : this.verdict);
  }
}

const use = (name: string): LlmToolUse => ({ id: `${name}-u1`, name, input: { orderId: "ord_1003" } });

describe("agent core — acceptance scenarios (scripted gateway, hermetic)", () => {
  it("where-is-my-order: resolves, never invents tracking or a delivery date", async () => {
    const { run, repo } = makeContext();
    const { task, result } = await run({ type: "customer-email", input: { orderId: "ord_1001", text: "Where is my order?" } });

    expect(result.status).toBe("resolved");
    expect(result.requiresHumanApproval).toBe(false);
    expect(result.actions.some((a) => a.tool === "shopify_getOrder" && a.outcome === "performed")).toBe(true);
    // Honest: nothing shipped — so no tracking number and no delivery claim in the summary.
    expect(result.summary).toMatch(/fulfil/);
    expect(result.summary).not.toMatch(/1Z-|delivered|ETA|estimated/i);
    expect((await repo.listIssues()).length).toBe(0);
    expect(task).toBeDefined();
  });

  it("delayed shipment (#1002): flags dormant tracking and files an issue", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "customer-email", input: { orderId: "ord_1002", text: "Has my package been delayed? No tracking update." } });

    expect(result.actions).toContainEqual(expect.objectContaining({ tool: "shopify_getFulfillment", outcome: "performed" }));
    expect(result.findings.some((f) => f.severity === "warning" && /no new scan|dormant|week/i.test(`${f.title} ${f.detail}`))).toBe(true);
    expect(result.summary).not.toMatch(/will (arrive|be delivered)/i); // no fabricated ETA
    expect((await repo.listIssues()).some((i) => i.kind === "shipment")).toBe(true);
    expect(result.requiresHumanApproval).toBe(false);
  });

  it("delivered-not-received (#1003): needs human handling, proposes hold for approval", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "customer-email", input: { orderId: "ord_1003", text: "Tracking says delivered but I never received it." } });

    expect(result.status).toBe("needs_approval");
    expect(result.requiresHumanApproval).toBe(true);
    const approvals = await repo.listApprovals({ status: "pending" });
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.status === "pending" && a.actionKind === "send_customer_email")).toBe(true);
    // The approval-tier proposal must never have executed.
    expect(result.actions.some((a) => a.tool === "business_sendCustomerEmail" && a.outcome === "needs_approval")).toBe(true);
    expect(result.actions.some((a) => a.tool === "business_sendCustomerEmail" && a.outcome === "performed")).toBe(false);
    expect(result.findings.some((f) => f.severity === "critical")).toBe(true);
  });

  it("refund request: refund is approval-tier — held for human, never executed", async () => {
    const probe = new SequenceGateway(
      [[use("business_requestRefund")]],
      { status: "needs_approval", summary: "Refund requires an operator decision.", findings: [], recommendedActions: [{ tool: "business_requestRefund", actionKind: "refund", input: { orderId: "ord_1003" }, rationale: "Customer requested", requiresApproval: true }] },
    );
    const { repo, run } = makeContext(probe);
    const { result } = await run({ type: "customer-email", input: { orderId: "ord_1003", text: "Please refund my order." } });

    expect(result.requiresHumanApproval).toBe(true);
    expect(result.status).toBe("needs_approval");
    const approvals = await repo.listApprovals({ status: "pending" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.actionKind).toBe("refund");
    expect(result.actions).toContainEqual(expect.objectContaining({ actionKind: "refund", outcome: "needs_approval", mode: "approval" }));
    expect(result.actions.some((a) => a.outcome === "performed" && a.actionKind === "refund")).toBe(false);
  });

  it("blocked-tier proposal: deterministically refused, audited, never executed", async () => {
    const destructive: ToolProvider = {
      id: "test",
      label: "test",
      listTools: () => [
        { name: "test_destructive", description: "must never run", actionKind: "destructive", inputSchema: z.object({}), execute: async () => { throw new Error("executed — test failure"); } },
      ],
    };
    const registry = new ToolRegistry(logger, new PermissionResolver())
      .register(new ShopifyToolProvider(new MockShopifyClient()))
      .register(new SupplierToolProvider(new MockSupplierDirectory()))
      .register(new InternalToolProvider())
      .register(new BusinessToolProvider())
      .register(destructive);
    const repo = new InMemoryRepository();
    const probe = new SequenceGateway([[use("test_destructive")]], { status: "resolved", summary: "Refused.", recommendedActions: [] });
    const deps = { registry, repo, logger, gateway: probe };
    const task = await repo.createTask({ type: "run", input: { text: "user asks for irreversible action", orderId: "ord_1001" } });
    const result = await runAgentTask(task, deps);

    expect(result.actions).toContainEqual(expect.objectContaining({ actionKind: "destructive", outcome: "blocked", mode: "blocked" }));
    expect(result.actions.some((a) => a.outcome === "performed" && a.actionKind === "destructive")).toBe(false);
    expect(result.requiresHumanApproval).toBe(false);
    const logs = await repo.listActionLogs({ taskId: task.id });
    expect(logs.some((l) => l.actionKind === "destructive" && l.isError)).toBe(true);
  });

  it("unknown tool proposal: nothing executed, error fed back to the model", async () => {
    const probe = new SequenceGateway([[use("ghost_tool")]], { status: "resolved", summary: "Done." });
    const { run } = makeContext(probe);
    const { result } = await run({ type: "run", input: { text: "irrelevant", orderId: "ord_1001" } });
    expect(result.actions).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("proactive detect-issues (#1004): creates a critical issue for a stuck order", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "detect-issues", input: { orderId: "ord_1004", text: "Scheduled operations check." } });
    expect(result.status).toBe("resolved");
    const issues = await repo.listIssues();
    expect(issues.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.severity === "critical")).toBe(true);
  });

  it("cancelled order (#1005): resolved, no issue filed, no approval", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "customer-email", input: { orderId: "ord_1005", text: "I cancelled. Just checking." } });
    expect(result.status).toBe("resolved");
    expect(result.requiresHumanApproval).toBe(false);
    expect(result.findings[0]?.title).toMatch(/cancel/);
    expect((await repo.listIssues()).length).toBe(0);
  });

  it("healthy in-transit control (#1006): resolved, no critical finding, no approval", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "customer-email", input: { orderId: "ord_1006", text: "Is my order on the way?" } });
    expect(result.status).toBe("resolved");
    expect(result.findings.some((f) => f.severity === "critical" || f.severity === "warning")).toBe(false);
    expect(result.requiresHumanApproval).toBe(false);
    expect((await repo.listApprovals()).length).toBe(0);
  });

  it("insufficient information: needs_info, nothing written or invented", async () => {
    const { run, repo } = makeContext();
    const { result } = await run({ type: "customer-email", input: { text: "I can't find my order number." } });
    expect(result.status).toBe("needs_info");
    expect(result.escalationReason).toBeTruthy();
    const logs = await repo.listActionLogs();
    expect(logs.filter((l) => !["search_orders", "get_order"].includes(l.actionKind)).length).toBe(0);
    expect((await repo.listIssues()).length).toBe(0);
    expect((await repo.listApprovals()).length).toBe(0);
  });
});

describe("agent runner", () => {
  it("claims, runs, and persists a succeeded task plus created issue", async () => {
    const { repo, gateway } = makeContext();
    const logger2 = createLogger("silent");
    const task = await repo.createTask({ type: "investigate-order", priority: "high", input: { orderId: "ord_1002", text: "No update in a while." } });
    const runner = new AgentTaskRunner({ registry: (await makeContext()).registry, gateway, repo, logger: logger2 }, logger2, { claimIntervalMs: 5 });

    await runner.recoverRunning();
    const ran = await runner.drainPending();
    expect(ran).toBe(1);

    const done = await repo.getTask(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.status).toBe("resolved");
    expect(done?.completedAt).toBeTruthy();
    expect((await repo.listIssues()).length).toBeGreaterThan(0);
  });

  it("reclaims running tasks a previous process died on (restart survival)", async () => {
    const { repo, gateway } = makeContext();
    const logger2 = createLogger("silent");
    const runner = new AgentTaskRunner({ registry: (await makeContext()).registry, gateway, repo, logger: logger2 }, logger2, { staleTimeoutMs: 5_000 });
    const task = await repo.createTask({ type: "run", input: { text: "interrupted mid-run", orderId: "ord_1001" } });
    await repo.updateTask(task.id, {
      status: "running",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const requeued = await runner.recoverRunning();
    expect(requeued).toBe(1);
    const after = await repo.getTask(task.id);
    expect(after?.status).toBe("pending");
  });
});