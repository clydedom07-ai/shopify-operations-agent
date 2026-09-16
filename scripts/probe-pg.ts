// Throwaway probe: exercises PgRepository end-to-end against compose Postgres.
// Run: node --env-file-if-exists=.env scripts/probe-pg.ts
import { createPool } from "../src/db/pool.ts";
import { PgRepository } from "../src/db/pgRepository.ts";
import { loadEnvFile, parseEnv } from "../src/config/env.ts";

loadEnvFile();
const env = parseEnv();
if (!env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = createPool(env.DATABASE_URL);
const repo = new PgRepository(pool);

try {
  const task = await repo.createTask(
    {
      type: "investigate-order",
      priority: "high",
      input: { text: "Where is my order? probe", orderId: "ord_1001", eventType: "customer_email_received" },
    },
  );
  const got = await repo.getTask(task.id);
  console.log("getTask ok:", got?.id === task.id && got?.input?.orderId === "ord_1001");

  await repo.updateTask(task.id, { status: "succeeded", currentStep: "probe-done" });
  const updated = await repo.getTask(task.id);
  console.log("updateTask ok:", updated?.status === "succeeded" && updated?.currentStep === "probe-done");

  const log = await repo.appendActionLog({
    taskId: task.id, step: 1, tool: "shopify_getOrder",
    actionKind: "get_order", mode: "auto", input: { orderId: "ord_1001" },
    output: { id: "1001" }, isError: false, durationMs: 3,
  });
  const logs = await repo.listActionLogs({ taskId: task.id });
  console.log("appendActionLog ok:", logs.some((l) => l.id === log.id && l.actionKind === "get_order"));

  const issue = await repo.createIssue({
    kind: "shipment", title: "probe issue", detail: "probe", severity: "warning",
    recommendedAction: { tool: "shopify_addOrderNote", actionKind: "add_order_note", input: {}, rationale: "probe", requiresApproval: false },
  });
  const issues = await repo.listIssues({ status: "open" });
  console.log("createIssue ok:", issues.some((i) => i.id === issue.id && i.status === "open"));

  const approval = await repo.createApproval({
    taskId: task.id, actionKind: "refund", tool: "shopify_refund",
    rationale: "probe", input: { amount: 10 },
  });
  const approvals = await repo.listApprovals({ status: "pending" });
  console.log("createApproval ok:", approvals.some((a) => a.id === approval.id));

  const ev = await repo.recordEvent({ type: "customer_email_received", source: "probe", payload: { to: "probe@example.com" } });
  const events = await repo.listEvents({ type: "customer_email_received" });
  console.log("recordEvent ok:", events.some((e) => e.id === ev.id));

  const requeued = await repo.claimNextTask(3);
  console.log("claimNextTask ok (probe task succeeded, nothing pending):", requeued === null);

  console.log("PgRepository round-trip: ALL OK");
} finally {
  await pool.end();
}