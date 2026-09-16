import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";
import { PermissionResolver } from "../domain/permissions.ts";
import type { AgentEventType } from "../domain/types.ts";
import { ShopifyToolProvider } from "../tools/shopify/provider.ts";
import { MockShopifyClient } from "../tools/shopify/mockClient.ts";
import { InternalToolProvider } from "../tools/internal/provider.ts";
import { BusinessToolProvider } from "../tools/business/provider.ts";
import { SupplierToolProvider } from "../tools/supplier/provider.ts";
import { MockSupplierDirectory } from "../supplier/mockDirectory.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ScriptedLlmGateway } from "../llm/scriptedGateway.ts";
import { AgentTaskRunner } from "../agent/runner.ts";
import { runAgentTask } from "../agent/core.ts";
import { createLogger } from "../lib/logger.ts";
import { ingestInbound } from "./ingestor.ts";
import type { InboundEmail } from "./types.ts";

const logger = createLogger("silent");

function makeDeps() {
  const repo = new InMemoryRepository();
  const registry = new ToolRegistry(logger, new PermissionResolver())
    .register(new ShopifyToolProvider(new MockShopifyClient()))
    .register(new SupplierToolProvider(new MockSupplierDirectory()))
    .register(new InternalToolProvider())
    .register(new BusinessToolProvider());
  const gateway = new ScriptedLlmGateway(logger);
  const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger, { claimIntervalMs: 5 });
  return { repo, registry, gateway, runner };
}

describe("email/ingestor", () => {
  it("ingests a supplier delay email and runs to a pending dispute approval", async () => {
    const { repo, registry, gateway } = makeDeps();
    const supplierName = "Atlas Textiles";
    const reference = "PO-2026-0142";
    const email: InboundEmail = {
      id: `em_supplier_delay_${randomUUID()}`,
      kind: "supplier",
      from: { name: "Atlas Textiles Ops", address: "orders@atlas-textiles.example" },
      subject: "Re: PO-2026-0142 — shipment is running late",
      body: "Just to confirm on PO-2026-0142: the loom maintenance knocked the whole batch.",
      receivedAt: new Date().toISOString(),
      supplierName,
      reference,
    };

    const result = await ingestInbound([email], repo, logger);
    expect(result.read).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.type).toBe("supplier-email");

    // supplier_email_received event was recorded
    const supplierEvents = (await repo.listEvents({ type: "supplier_email_received" as AgentEventType, limit: 10 })).filter(
      (e) => e.payload["emailId"] === email.id,
    );
    expect(supplierEvents).toHaveLength(1);
    expect(supplierEvents[0]!.payload["supplierName"]).toBe(supplierName);
    expect(supplierEvents[0]!.payload["reference"]).toBe(reference);

    // Run via the agent
    const task = (await repo.getTask(result.tasks[0]!.taskId))!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 8 });

    // Verdict reflects a real supplier delay, with no invented dates
    expect(agentResult.status).toBe("needs_approval");
    expect(agentResult.requiresHumanApproval).toBe(true);
    expect(agentResult.findings.some((f) => f.kind === "supplier" && f.detail.includes(supplierName))).toBe(true);

    // supplier_delay_detected event was recorded as ground-truth audit
    const delayEvents = await repo.listEvents({ type: "supplier_delay_detected" as AgentEventType, limit: 10 });
    expect(delayEvents).toHaveLength(1);
    expect(delayEvents[0]!.payload["supplierName"]).toBe(supplierName);
    expect(delayEvents[0]!.payload["reference"]).toBe(reference);

    // Pending supplier_dispute approval — never executed
    const approvals = await repo.listApprovals({ status: "pending" });
    expect(approvals.some((a) => a.actionKind === "supplier_dispute")).toBe(true);
    expect(approvals.find((a) => a.actionKind === "supplier_dispute")!.input["supplierName"]).toBe(supplierName);

    // Summary references the supplier and is honest about timing
    const summary = agentResult.summary.toLowerCase();
    expect(summary).toContain("atlas textiles");
    expect(summary).toContain("delayed");
  });

  it("resolves a supplier on_track email with no issue or approval", async () => {
    const { repo, registry, gateway } = makeDeps();
    const email: InboundEmail = {
      id: `em_supplier_ok_${randomUUID()}`,
      kind: "supplier",
      from: { name: "Brightwave Knits Supply", address: "supply@brightwave-knits.example" },
      subject: "PO shipment update",
      body: "Heads up that the next knits shipment is on schedule as planned.",
      receivedAt: new Date().toISOString(),
      supplierName: "Brightwave Knits",
    };

    const result = await ingestInbound([email], repo, logger);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.type).toBe("supplier-email");

    const task = (await repo.getTask(result.tasks[0]!.taskId))!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 6 });

    expect(agentResult.status).toBe("resolved");
    expect(agentResult.requiresHumanApproval).toBe(false);
    expect(agentResult.findings.some((f) => f.kind === "supplier" && f.detail.includes("Brightwave Knits"))).toBe(true);
    expect(agentResult.recommendedActions.some((a) => a.actionKind === "supplier_dispute")).toBe(false);
    expect((await repo.listIssues({ kind: "supplier" })).length).toBe(0);
    expect((await repo.listApprovals({ status: "pending" })).length).toBe(0);
  });

  it("ingests a customer email and resolves it against order 1001", async () => {
    const { repo, registry, gateway } = makeDeps();
    const email: InboundEmail = {
      id: `em_customer_${randomUUID()}`,
      kind: "customer",
      from: { name: "Ava Morgan", address: "ava@example.com" },
      subject: "Where is my order?",
      body: "Hi, I ordered #1001 over a week ago and haven't heard anything.",
      receivedAt: new Date().toISOString(),
    };

    const result = await ingestInbound([email], repo, logger);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.type).toBe("customer-email");

    const customerEvents = (await repo.listEvents({ type: "customer_email_received" as AgentEventType, limit: 10 })).filter(
      (e) => e.payload["emailId"] === email.id,
    );
    expect(customerEvents).toHaveLength(1);
    expect(customerEvents[0]!.payload["from"]).toBe("ava@example.com");

    const task = (await repo.getTask(result.tasks[0]!.taskId))!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 6 });

    expect(agentResult.status).toBe("resolved");
    // The order name (from the search result) appears in the summary
    expect(agentResult.summary).toContain("#1001");
  });

  it("skips duplicate emails on re-ingestion (idempotent)", async () => {
    const { repo } = makeDeps();
    const email: InboundEmail = {
      id: `em_dup_${randomUUID()}`,
      kind: "customer",
      from: { name: "Test", address: "test@example.com" },
      subject: "Dup test",
      body: "Dup test body",
      receivedAt: new Date().toISOString(),
    };

    const first = await ingestInbound([email], repo, logger);
    expect(first.tasks).toHaveLength(1);
    expect(first.skipped).toBe(0);

    const second = await ingestInbound([email], repo, logger);
    expect(second.tasks).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });
});
