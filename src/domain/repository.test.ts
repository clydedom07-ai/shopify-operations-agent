import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";

describe("InMemoryRepository", () => {
  it("creates and fetches a task", async () => {
    const repo = new InMemoryRepository();
    const task = await repo.createTask({ type: "investigate-order", input: { text: "Where is #1001?" } }, "t-1");
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(0);

    const fetched = await repo.getTask("t-1");
    expect(fetched?.type).toBe("investigate-order");
    expect(fetched?.input.text).toContain("#1001");
    expect(await repo.getTask("missing")).toBeNull();
  });

  it("filters task listings by status", async () => {
    const repo = new InMemoryRepository();
    await repo.createTask({ type: "run", input: { text: "a" } }, "t-a");
    await repo.updateTask("t-a", { status: "succeeded", result: null });
    await repo.createTask({ type: "run", input: { text: "b" } }, "t-b");

    const pending = await repo.listTasks({ status: "pending" });
    expect(pending.map((t) => t.id)).toEqual(["t-b"]);
  });

  it("requeues stale running tasks on restart (task state survives)", async () => {
    const repo = new InMemoryRepository();
    await repo.createTask({ type: "run", input: { text: "old" } }, "t-running");
    await repo.updateTask("t-running", {
      status: "running",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repo.createTask({ type: "run", input: { text: "fresh" } }, "t-fresh");
    await repo.updateTask("t-fresh", {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const requeued = await repo.requeueRunning(30_000);
    expect(requeued).toBe(1);
    expect((await repo.getTask("t-running"))?.status).toBe("pending");
    expect((await repo.getTask("t-fresh"))?.status).toBe("running");
  });

  it("claims the next pending task atomically and counts attempts", async () => {
    const repo = new InMemoryRepository();
    await repo.createTask({ type: "run", input: { text: "first" } }, "t-1");
    await repo.createTask({ type: "run", input: { text: "second" } }, "t-2");

    const claimed = await repo.claimNextTask(3);
    expect(claimed?.id).toBe("t-1");
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect((await repo.claimNextTask(3))?.id).toBe("t-2");
    expect(await repo.claimNextTask(3)).toBeNull();
  });

  it("writes an audit trail: actions, issues, approvals, events", async () => {
    const repo = new InMemoryRepository();
    const task = await repo.createTask({ type: "run", input: { text: "x" } }, "t-1");

    await repo.appendActionLog({ taskId: task.id, step: 1, tool: "shopify_getOrder", actionKind: "get_order", mode: "auto", input: { id: "ord_1" }, output: { ok: true }, isError: false, durationMs: 3 });
    const logs = await repo.listActionLogs({ taskId: task.id });
    expect(logs).toHaveLength(1);
    expect(logs[0].tool).toBe("shopify_getOrder");

    const issue = await repo.createIssue({ kind: "shipment_delay", title: "Dormant tracking", detail: "No scan in 9 days", severity: "warning", taskId: task.id });
    expect(issue.status).toBe("open");
    expect((await repo.listIssues({ status: "open" }))[0].id).toBe(issue.id);

    const approval = await repo.createApproval({ taskId: task.id, issueId: issue.id, actionKind: "refund", tool: "refund_order", rationale: "100% refund", input: { orderId: "ord_1" } });
    expect(approval.status).toBe("pending");
    await repo.updateApproval(approval.id, { status: "approved", decidedBy: "operator@example.com", decidedAt: new Date().toISOString() });
    expect((await repo.getApproval(approval.id))?.status).toBe("approved");

    const ev = await repo.recordEvent({ type: "order_created", payload: { orderId: "ord_9" }, source: "webhook" });
    expect(ev.type).toBe("order_created");
    expect(await repo.listEvents({ type: "shipment_delayed" })).toHaveLength(0);
  });
});