/**
 * Shared domain types for the Shopify Operations Agent.
 *
 * Layering rule: the domain knows nothing about HTTP, the LLM SDK, or
 * transports. The agent core, tools, and API all speak these types.
 */

// ── Tasks ────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskType = "run" | "investigate-order" | "customer-email" | "supplier-email" | "slack-message" | "detect-issues";

export type AgentEventType =
  | "order_created"
  | "order_updated"
  | "shipment_delayed"
  | "shipment_delivered"
  | "customer_email_received"
  | "supplier_email_received"
  | "supplier_delay_detected"
  | "slack_message_received"
  | "scheduled_operations_check"
  | "manual_investigation";

export interface TaskInput {
  /** The raw text — a customer message, an event payload summary, an instruction. */
  text: string;
  orderId?: string;
  customerEmail?: string;
  eventType?: AgentEventType;
  metadata?: Record<string, unknown>;
}

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  input: TaskInput;
  result?: StructuredResult | null;
  error?: { message: string; category?: string; retryable: boolean } | null;
  currentStep?: string | null;
  priority?: Priority | null;
  attempts: number;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Structured agent result ──────────────────────────────────────────────────

export type AgentStatus = "resolved" | "needs_approval" | "needs_info" | "error";

export interface Finding {
  id: string;
  /** e.g. "order", "shipment", "customer", "inventory", "supplier" */
  kind: string;
  title: string;
  detail: string;
  /** The tool call / audit source the finding traces to. */
  source: string;
  severity: "info" | "warning" | "critical";
  data?: Record<string, unknown>;
}

export interface RecommendedAction {
  tool: string;
  actionKind: ActionKind;
  input: Record<string, unknown>;
  rationale: string;
  requiresApproval: boolean;
}

export interface ActionRecord {
  actionKind: ActionKind;
  tool: string;
  mode: PermissionMode;
  outcome: "performed" | "needs_approval" | "blocked" | "failed";
  detail?: string;
  at: string;
}

export interface StructuredResult {
  status: AgentStatus;
  summary: string;
  intent?: string;
  priority: Priority;
  /**
   * INFORMATIONAL ONLY. Never consulted by the permission system — permissions
   * are enforced deterministically from the action kind.
   */
  confidence?: string;
  findings: Finding[];
  actions: ActionRecord[];
  recommendedActions: RecommendedAction[];
  requiresHumanApproval: boolean;
  escalationReason?: string;
}

// ── Permissions ──────────────────────────────────────────────────────────────

export type ActionKind =
  // read / investigate
  | "search_orders"
  | "get_order"
  | "get_customer"
  | "get_product"
  | "get_fulfillment"
  | "get_inventory"
  | "get_supplier"
  | "search_email"
  // non-risky writes
  | "add_order_note"
  | "create_issue"
  | "supplier_delay"
  | "send_routine_customer_update"
  | "send_internal_notification"
  | "trigger_n8n_workflow"
  | "slack_post_message"
  // generic outbound REST (operator-configured base origin only)
  | "rest_http_get"
  | "rest_http_write"
  // financially / operationally significant
  | "refund"
  | "replacement"
  | "discount"
  | "order_modification"
  | "supplier_dispute"
  | "policy_exception"
  | "send_customer_email"
  // never allowed
  | "access_credentials"
  | "destructive";

export type PermissionMode = "auto" | "approval" | "blocked";

// ── Audit trail ──────────────────────────────────────────────────────────────

export interface ActionLogRow {
  id: string;
  taskId: string;
  step: number;
  tool: string;
  actionKind: ActionKind;
  mode: PermissionMode;
  input: Record<string, unknown>;
  output?: unknown | null;
  isError: boolean;
  durationMs?: number | null;
  createdAt: string;
}

// ── Issues ───────────────────────────────────────────────────────────────────

export type IssueStatus = "open" | "resolved" | "escalated";

export interface Issue {
  id: string;
  kind: string;
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  status: IssueStatus;
  taskId?: string | null;
  recommendedAction?: RecommendedAction | null;
  createdAt: string;
  resolvedAt?: string | null;
}

// ── Human-in-the-loop approvals ──────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  taskId: string;
  issueId?: string | null;
  actionKind: ActionKind;
  tool: string;
  rationale: string;
  input: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
}