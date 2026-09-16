import type { ActionKind, AgentStatus, Finding, Priority, StructuredResult, Task } from "../domain/types.ts";

/**
 * n8n callback integration.
 *
 * Direction of travel: the agent CALLS BACK into n8n. When an investigation
 * task completes, the runner POSTs a compact, truth-only summary of what
 * happened to an n8n Webhook trigger, so the surrounding automation graph can
 * continue (post a Slack message, kick off a downstream job, archive the case).
 *
 * Like the Shopify client and the email provider, the webhook client sits
 * behind an interface — `mock` for hermetic dev/tests, `http` for the real
 * Webhook URL. The callback payload is derived from recorded ground truth
 * (task + structured result), never from model narration.
 */

export interface N8nCallbackPayload {
  event: "task_completed";
  taskId: string;
  taskType: Task["type"];
  status: AgentStatus;
  summary: string;
  intent?: string;
  priority: Priority;
  requiresHumanApproval: boolean;
  escalationReason?: string;
  actions: Array<{ actionKind: ActionKind; outcome: string }>;
  findings: Array<{ kind: string; severity: Finding["severity"]; title: string }>;
  pendingApprovals: Array<{ id: string; actionKind: ActionKind }>;
  completedAt: string;
}

export interface N8nNotifyResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * The wire payload is permissive (whatever the configured workflow expects);
 * the two producers are the typed task_completed builder and the workflow tool.
 */
export interface N8nWebhookClient {
  readonly id: "mock" | "http";
  notify(payload: Record<string, unknown>): Promise<N8nNotifyResult>;
}

/**
 * Derive the webhook payload strictly from persisted truth — the task record
 * and its structured result. Pending approvals are surfaced from the recorded
 * `needs_approval` actions (their `detail` carries the approval id), so no
 * second query is needed and the payload can never exceed what actually ran.
 */
export function buildN8nCallbackPayload(task: Task, result: StructuredResult): N8nCallbackPayload {
  return {
    event: "task_completed",
    taskId: task.id,
    taskType: task.type,
    status: result.status,
    summary: result.summary,
    intent: result.intent,
    priority: result.priority,
    requiresHumanApproval: result.requiresHumanApproval,
    escalationReason: result.escalationReason,
    actions: result.actions.map((a) => ({ actionKind: a.actionKind, outcome: a.outcome })),
    findings: result.findings.slice(0, 40).map((f) => ({ kind: f.kind, severity: f.severity, title: f.title })),
    pendingApprovals: result.actions
      .filter((a) => a.outcome === "needs_approval")
      .map((a) => ({ id: a.detail ?? "", actionKind: a.actionKind })),
    completedAt: task.completedAt ?? new Date().toISOString(),
  };
}