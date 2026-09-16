import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentEventType, ApprovalStatus, TaskType } from "../domain/types.ts";
import type { Repository } from "../domain/repository.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/provider.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * HTTP API for the agent. Everything here is a thin, validated adapter over the
 * repository and the registry:
 *  - enqueue endpoints create a task (worker executes it) and record the event;
 *  - query endpoints read the audit trail, issues, approvals, and task results;
 *  - the approval-decide endpoint is the one place a human decision turns into
 *    an actual tool execution — and the execution goes through the SAME audited
 *    dispatch the agent uses, so "executed only after approval" is structural.
 * Every endpoint requires `Authorization: Bearer <API_AUTH_TOKEN>` except /health.
 */

export const AGENT_EVENT_TYPES = [
  "order_created",
  "order_updated",
  "shipment_delayed",
  "shipment_delivered",
  "customer_email_received",
  "supplier_email_received",
  "supplier_delay_detected",
  "slack_message_received",
  "scheduled_operations_check",
  "manual_investigation",
] as const;

const bodySchema = z.object({
  /** The raw input — a customer message, event summary, or instruction. */
  text: z.string().min(1),
  orderId: z.string().optional(),
  customerEmail: z.string().optional(),
  eventType: z.enum(AGENT_EVENT_TYPES).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const decideSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  actor: z.string().min(1).optional(),
  reason: z.string().optional(),
});

/** Which task type + recorded event each enqueue route stands for. */
export const ROUTE_SPECS = {
  run: { taskType: "run" as TaskType, defaultEvent: "manual_investigation" as AgentEventType },
  "customer-email": { taskType: "customer-email" as TaskType, defaultEvent: "customer_email_received" as AgentEventType },
  "investigate-order": { taskType: "investigate-order" as TaskType, defaultEvent: "manual_investigation" as AgentEventType },
  "slack-message": { taskType: "slack-message" as TaskType, defaultEvent: "slack_message_received" as AgentEventType },
  "detect-issues": { taskType: "detect-issues" as TaskType, defaultEvent: "scheduled_operations_check" as AgentEventType },
} as const;

export interface ApiDeps {
  repo: Repository;
  registry: ToolRegistry;
  logger: Logger;
  apiAuthToken: string;
  /** Human label for /health ("postgres" | "memory"). */
  persistence: string;
}

const zErrorDetail = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url === "/health") return;
    const expected = `Bearer ${deps.apiAuthToken}`;
    if (req.headers.authorization !== expected) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  const enqueueRoute = (
    path: `/${string}`,
    spec: (typeof ROUTE_SPECS)[keyof typeof ROUTE_SPECS],
    source: string,
  ) => {
    app.post<{ Body: unknown }>(path, async (req, reply) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", detail: zErrorDetail(parsed.error) });
      }
      const { text, orderId, customerEmail, priority } = parsed.data;
      const eventType = parsed.data.eventType ?? spec.defaultEvent;
      await deps.repo.recordEvent({
        type: eventType,
        source,
        payload: { text, orderId: orderId ?? null, customerEmail: customerEmail ?? null },
      });
      const task = await deps.repo.createTask({
        type: spec.taskType,
        priority,
        input: { text, orderId, customerEmail, eventType },
      });
      deps.logger.info({ taskId: task.id, route: path, eventType }, "agent task enqueued");
      return reply.code(201).send({ taskId: task.id, status: task.status, eventType });
    });
  };

  enqueueRoute("/agent/run", ROUTE_SPECS.run, "api");
  enqueueRoute("/agent/customer-email", ROUTE_SPECS["customer-email"], "api");
  enqueueRoute("/agent/investigate-order", ROUTE_SPECS["investigate-order"], "api");
  enqueueRoute("/agent/slack-message", ROUTE_SPECS["slack-message"], "api");
  enqueueRoute("/agent/detect-issues", ROUTE_SPECS["detect-issues"], "api");

  app.get("/health", async () => {
    const pendingTasks = await deps.repo.listTasks({ status: "pending" });
    return { ok: true, service: "shopify-operations-agent", persistence: deps.persistence, pendingTasks: pendingTasks.length };
  });

  app.get<{ Querystring: { taskId?: string } }>("/agent/actions", async (req) => {
    const { taskId } = req.query;
    const rows = await deps.repo.listActionLogs(taskId?.trim() ? { taskId: taskId.trim() } : undefined);
    return { actions: rows };
  });

  app.get<{ Querystring: { status?: string } }>("/agent/issues", async (req) => {
    const status = req.query.status as "open" | "resolved" | "escalated" | undefined;
    const rows = await deps.repo.listIssues(status ? { status } : undefined);
    return { issues: rows };
  });

  app.get<{ Querystring: { status?: string } }>("/agent/approvals", async (req) => {
    const status = req.query.status as ApprovalStatus | undefined;
    const rows = await deps.repo.listApprovals(status ? { status } : undefined);
    return { approvals: rows };
  });

  app.get<{ Params: { id: string } }>("/agent/tasks/:id", async (req, reply) => {
    const task = await deps.repo.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "task_not_found" });
    return { task };
  });

  /**
   * Human-in-the-loop: only THIS endpoint may turn "approved" into an execution,
   * and the execution goes through the audited registry dispatch (same path as
   * auto-tier tools). Approved-but-no-live-integration tools (refund, customer
   * email) are attempted and honestly report `executed:false` with the refusal —
   * the agent never claims work it did not perform.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/agent/approvals/:id/decide", async (req, reply) => {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", detail: zErrorDetail(parsed.error) });
    }
    const approval = await deps.repo.getApproval(req.params.id);
    if (!approval) return reply.code(404).send({ error: "approval_not_found" });
    if (approval.status !== "pending") {
      return reply.code(409).send({ error: "already_decided", status: approval.status });
    }

    const { decision, reason } = parsed.data;
    const actor = parsed.data.actor ?? "operator";
    const now = new Date().toISOString();

    let executed = false;
    let outcome: string;
    let refusal: string | undefined;

    if (decision === "approved") {
      const ctx: ToolContext = { taskId: approval.taskId, step: 0, logger: deps.logger, repo: deps.repo };
      const tool = deps.registry.get(approval.tool);
      if (!tool) {
        outcome = "not_executed";
        refusal = `Approved action '${approval.tool}' is not a registered tool; nothing was executed.`;
      } else {
        const disp = await deps.registry.dispatch(approval.tool, approval.input, ctx);
        executed = disp.ok;
        outcome = disp.ok ? "executed" : "refused";
        if (!disp.ok) refusal = disp.error;
      }
    } else {
      outcome = "not_executed";
    }

    await deps.repo.updateApproval(approval.id, { status: decision, decidedBy: actor, decidedAt: now });
    await deps.repo.appendActionLog({
      taskId: approval.taskId,
      step: 0,
      tool: approval.tool,
      actionKind: approval.actionKind,
      mode: "approval",
      input: approval.input,
      output: { outcome, decision, reason, executed },
      isError: false,
      durationMs: null,
    });

    deps.logger.info({ approvalId: approval.id, decision, outcome }, "approval decided");
    return reply.code(200).send({ approvalId: approval.id, status: decision, executed, outcome, refusal });
  });

  return app;
}