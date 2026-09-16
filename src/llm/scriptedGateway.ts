import type { Fulfillment, Order, TrackingEvent } from "../tools/shopify/types.ts";
import type { Supplier } from "../supplier/types.ts";
import type { AgentStatus, Finding, Priority, RecommendedAction } from "../domain/types.ts";
import type { Logger } from "../lib/logger.ts";
import type { LlmGateway, LlmRequest, LlmResponse, LlmToolUse } from "./gateway.ts";

/**
 * Deterministic, credential-free LLM gateway ("SOP as code").
 *
 * Runs when no ANTHROPIC_API_KEY is configured, so every acceptance scenario is
 * testable without network or money. It mirrors what a real model would do —
 * propose investigation tool uses, then a structured verdict — but every fact it
 * emits comes only from tool results already present in the transcript. It never
 * invents tracking numbers, dates, refunds, or supplier statements.
 */

const DAY = 86_400_000;
const daysSince = (iso: string): number => (Date.now() - Date.parse(iso)) / DAY;

interface TaskContext {
  taskType?: string;
  text?: string;
  orderId?: string | null;
  customerEmail?: string | null;
  eventType?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface Verdict {
  status: AgentStatus;
  summary: string;
  priority: Priority;
  confidence: string;
  findings: Array<Omit<Finding, "id" | "source">>;
  recommendedActions: RecommendedAction[];
  escalationReason?: string;
  issue?: { kind: string; title: string; detail: string; severity: Finding["severity"] };
  approvalToolUse?: { name: string; input: Record<string, unknown> };
  /** Supplier flow only: the audited delay event to record before escalating. */
  supplierDelayEvent?: { supplierId: string; supplierName: string; reference: string | null; detail: string };
}

/** Extract the run context from the first text turn (the core sends JSON). */
function readContext(transcript: LlmRequest["transcript"]): TaskContext {
  const first = transcript.find((t) => t.role === "user" && t.text !== undefined);
  if (!first?.text) return {};
  try {
    return JSON.parse(first.text) as TaskContext;
  } catch {
    return { text: first.text };
  }
}

function hasProposed(transcript: LlmRequest["transcript"], name: string): boolean {
  return transcript.some((t) => t.role === "assistant" && t.toolUses?.some((u) => u.name === name));
}

function lastResult(transcript: LlmRequest["transcript"], name: string): unknown {
  let found: unknown;
  for (const t of transcript) {
    if (t.role === "user") {
      for (const r of t.toolResults ?? []) if (r.name === name) found = r.result;
    }
  }
  return found;
}

const toolUse = (name: string, input: Record<string, unknown>): LlmToolUse => ({ id: `tsk-${name}-${Date.now()}`, name, input });

/**
 * A literal order reference the customer wrote, e.g. "#1001" — taken from their
 * own message, never guessed. Lets free-text messages ("where is #1001?") reach
 * the right order in the mock search, which matches substrings of name/email/
 * line items and so cannot match a whole sentence.
 */
function orderRef(text?: string | null): string | null {
  return text ? (text.match(/#(\d{3,})/)?.[0] ?? null) : null;
}

// Latest event. Carriers report scans at day (or worse) granularity, so equal
// timestamps are normal — in that case the last event in the list is the newest.
// A `>=` reduce (not a sort) makes the winner deterministic on ties.
const lastEvent = (f: Fulfillment): TrackingEvent | undefined =>
  f.trackingEvents.reduce<TrackingEvent | undefined>(
    (latest, ev) => (latest === undefined || ev.occurredAt >= latest.occurredAt ? ev : latest),
    undefined,
  );

/** The shopify-domain SOP: order → shipment → verdict. */
function classify(order: Order, fulfillments: Fulfillment[]): Verdict {
  const rec = (tool: string, actionKind: RecommendedAction["actionKind"], input: Record<string, unknown>, rationale: string, requiresApproval: boolean): RecommendedAction => ({
    tool,
    actionKind,
    input,
    rationale,
    requiresApproval,
  });

  if (order.status === "cancelled") {
    return {
      status: "resolved",
      summary: `Order ${order.name} was cancelled before fulfillment — there is nothing to ship or refund on the order record.`,
      priority: "low",
      confidence: "high",
      findings: [
        { kind: "order", title: "Order cancelled", detail: `Order ${order.name} is marked cancelled (financial status ${order.financialStatus}).`, severity: "info" },
      ],
      recommendedActions: [],
      escalationReason: "Customer may still expect a refund; verify payment was voided before closing the ticket.",
    };
  }

  const fulfillment = fulfillments[0] ?? null;
  const age = daysSince(order.createdAt);

  // Nothing has shipped yet.
  if (order.fulfillmentStatus === "unfulfilled" || !fulfillment) {
    if (age >= 4) {
      return {
        status: "resolved",
        summary: `Order ${order.name} has been paid (${order.financialStatus}) but remains unfulfilled ${Math.floor(age)} days after creation — investigation flags it as stuck in fulfillment.`,
        priority: "high",
        confidence: "high",
        findings: [
          { kind: "shipment", title: "Order unfulfilled for an extended period", detail: `Paid on ${order.createdAt.slice(0, 10)}, still ${order.fulfillmentStatus ?? "not fulfilled"} after ${Math.floor(age)} days.`, severity: "critical" },
        ],
        recommendedActions: [
          rec("internal_createIssue", "create_issue", { title: "Order stuck in fulfillment", detail: `Order ${order.name} unfulfilled ${Math.floor(age)} days.`, severity: "critical" }, "File the stuck order for follow-up", false),
          rec("internal_sendNotification", "send_internal_notification", { message: `Order ${order.name} stuck unfulfilled` }, "Notify the fulfillment team", false),
        ],
        issue: { kind: "fulfillment", title: "Order stuck in fulfillment", detail: `Order ${order.name} paid but unfulfilled after ${Math.floor(age)} days.`, severity: "critical" },
        escalationReason: "Outstanding fulfillment older than the 4-day threshold; needs an operator/fulfillment investigation.",
      };
    }
    return {
      status: "resolved",
      summary: `Order ${order.name} is paid and awaiting fulfillment (created ${Math.floor(age)} day${age === 1 ? "" : "s"} ago). No tracking exists yet because nothing has shipped — there is no confirmed delivery date to share.`,
      priority: "low",
      confidence: "high",
      findings: [
        { kind: "order", title: "Order awaiting fulfillment", detail: `${order.fulfillmentStatus ?? "no fulfillment record"} — within normal window.`, severity: "info" },
      ],
      recommendedActions: [
        rec("internal_sendCustomerUpdate", "send_routine_customer_update", { orderId: order.id }, "Reassure customer with an honest status update", false),
      ],
    };
  }

  // Shipped / scanning.
  const ev = lastEvent(fulfillment);
  if (!ev) {
    return {
      status: "needs_info",
      summary: `Order ${order.name} is ${order.fulfillmentStatus} but the shipment record has no tracking events yet. I cannot confirm a location or ETA.`,
      priority: "medium",
      confidence: "medium",
      findings: [
        { kind: "shipment", title: "Shipment without tracking events", detail: `Fulfillment ${fulfillment.id} exists but carries no scans.`, severity: "warning" },
      ],
      recommendedActions: [],
      escalationReason: "Tracking data is missing; request a pickup scan from the carrier before promising anything.",
    };
  }

  if (ev.status === "delivered") {
    return {
      status: "needs_approval",
      summary: `Shipment for ${order.name} shows delivered ${ev.location ?? ""} on ${ev.occurredAt.slice(0, 10)}, but the customer says they never received it. This is a delivered-not-received case that needs human handling.`,
      priority: "high",
      confidence: "high",
      findings: [
        { kind: "shipment", title: "Marked delivered, customer says not received", detail: `Carrier scan '${ev.status}' ${ev.location ?? ""} ${ev.occurredAt.slice(0, 10)} on tracking ${fulfillment.trackingNumber}.`, severity: "critical" },
      ],
      recommendedActions: [
        rec("business_sendCustomerEmail", "send_customer_email", { orderId: order.id }, "Acknowledge and explain the next step (courier check)", true),
        rec("business_requestReplacement", "replacement", { orderId: order.id }, "Offer replacement/reship after carrier investigation", true),
      ],
      issue: { kind: "delivery", title: "Delivered but not received", detail: `Order ${order.name} marked delivered on ${ev.occurredAt.slice(0, 10)} by ${fulfillment.trackingCompany}; customer disputes.`, severity: "critical" },
      approvalToolUse: { name: "business_sendCustomerEmail", input: { orderId: order.id } },
      escalationReason: "Customer disputes delivery; needs an operator to open a carrier claim or authorize a reshipment.",
    };
  }

  if (ev.status === "exception" || ev.status === "returned") {
    return {
      status: "needs_approval",
      summary: `Tracking for ${order.name} shows an ${ev.status} scan ${ev.location ?? ""} on ${ev.occurredAt.slice(0, 10)}.`,
      priority: "high",
      confidence: "high",
      findings: [
        { kind: "shipment", title: `Shipment ${ev.status}`, detail: `Carrier ${fulfillment.trackingCompany} scan '${ev.status}' ${ev.location ?? ""} ${ev.occurredAt.slice(0, 10)}.`, severity: "critical" },
      ],
      recommendedActions: [
        rec("business_sendCustomerEmail", "send_customer_email", { orderId: order.id }, "Explain the delivery exception", true),
      ],
      issue: { kind: "delivery", title: `Shipment ${ev.status}`, detail: `Order ${order.name} marked ${ev.status} by carrier on ${ev.occurredAt.slice(0, 10)}.`, severity: "critical" },
      approvalToolUse: { name: "business_sendCustomerEmail", input: { orderId: order.id } },
      escalationReason: "Carrier exception requires an operator decision.",
    };
  }

  const scanAge = daysSince(ev.occurredAt);
  if (scanAge > 7) {
    return {
      status: "resolved",
      summary: `Tracking for ${order.name} has had no new scan in ${Math.floor(scanAge)} days (last: '${ev.status}' ${ev.location ?? ""} on ${ev.occurredAt.slice(0, 10)}). Flagged as a dormant shipment for the carrier to chase — no ETA can be confirmed.`,
      priority: "medium",
      confidence: "medium",
      findings: [
        { kind: "shipment", title: "No tracking update for over a week", detail: `Last scan '${ev.status}' ${ev.location ?? ""} ${ev.occurredAt.slice(0, 10)}; tracking ${fulfillment.trackingNumber}.`, severity: "warning" },
      ],
      recommendedActions: [
        rec("internal_createIssue", "create_issue", { title: "Dormant shipment", detail: `${order.name} — no scan since ${ev.occurredAt.slice(0, 10)}.`, severity: "warning" }, "Chase the carrier for movement", false),
        rec("internal_sendNotification", "send_internal_notification", { message: `${order.name}: ${Math.floor(scanAge)} days without a scan` }, "Notify shipping team", false),
      ],
      issue: { kind: "shipment", title: "Dormant shipment", detail: `Order ${order.name} last scanned ${ev.occurredAt.slice(0, 10)} (${Math.floor(scanAge)} days).`, severity: "warning" },
      escalationReason: "No scan in over a week — carrier check required.",
    };
  }

  return {
    status: "resolved",
    summary: `Shipment for ${order.name} is moving normally — latest scan '${ev.status}' ${ev.location ?? ""} on ${ev.occurredAt.slice(0, 10)}. No delivery ETA is promised beyond what the carrier shows.`,
    priority: "low",
    confidence: "medium",
    findings: [
      { kind: "shipment", title: "Shipment in transit", detail: `Latest scan '${ev.status}' ${ev.location ?? ""} ${ev.occurredAt.slice(0, 10)} on ${fulfillment.trackingCompany}.`, severity: "info" },
    ],
    recommendedActions: [],
  };
}

const FENCE = /```json\s*([\s\S]*?)```/;

/**
 * The supplier-domain SOP: consult the directory → classify the supplier's own
 * risk → record the delay (audited), file it, and propose a dispute for human
 * approval. Every date/status quoted comes from the directory record or the
 * email itself; nothing about a shipment is invented.
 */
function classifySupplier(supplier: Supplier, ctx: TaskContext): Verdict {
  const reference = typeof ctx.metadata?.["reference"] === "string" ? (ctx.metadata["reference"] as string) : null;
  const refText = reference ? ` referencing ${reference}` : "";
  const expected = supplier.expectedNextShipmentAt ?? null;

  if (supplier.risk === "on_track") {
    return {
      status: "resolved",
      summary: `Supplier ${supplier.name} is reported on track${refText}${expected ? `; the supplier system shows the next shipment expected ${expected.slice(0, 10)}` : ""}. No delay was found, so nothing was escalated and no customer was contacted.`,
      priority: "low",
      confidence: "high",
      findings: [
        {
          kind: "supplier",
          title: "Supplier shipment on schedule",
          detail: `${supplier.name} is marked on_track by the supplier system${expected ? ` (next shipment ${expected.slice(0, 10)})` : ""}.`,
          severity: "info",
        },
      ],
      recommendedActions: [],
    };
  }

  const riskLabel = supplier.risk === "at_risk" ? "at risk" : "delayed";
  const detail =
    `Supplier ${supplier.name} is marked ${supplier.risk} by the supplier system${refText}.` +
    (expected ? ` Next expected shipment ${expected.slice(0, 10)}.` : " No revised shipment date is on record.") +
    (supplier.notes ? ` Supplier notes: ${supplier.notes}` : "");

  const rec = (
    tool: string,
    actionKind: RecommendedAction["actionKind"],
    input: Record<string, unknown>,
    rationale: string,
    requiresApproval: boolean,
  ): RecommendedAction => ({ tool, actionKind, input, rationale, requiresApproval });

  return {
    status: "needs_approval",
    summary: `Supplier ${supplier.name} is ${riskLabel}${refText}. ${
      expected
        ? `The supplier system's next expected shipment is ${expected.slice(0, 10)}.`
        : "No revised shipment date is on record."
    } The delay has been recorded and filed; disputing it with the supplier requires human approval, and no customer has been told anything.`,
    priority: "high",
    confidence: "high",
    findings: [
      { kind: "supplier", title: "Supplier shipment delayed", detail, severity: "warning" },
    ],
    recommendedActions: [
      rec(
        "internal_createIssue",
        "create_issue",
        { kind: "supplier", title: `Supplier delay${refText}`, detail, severity: "warning" },
        "File the supplier delay for operations follow-up",
        false,
      ),
      rec(
        "internal_recordSupplierDelay",
        "supplier_delay",
        { supplierId: supplier.id, supplierName: supplier.name, reference, detail },
        "Record the detected delay as an auditable event",
        false,
      ),
      rec(
        "business_disputeSupplier",
        "supplier_dispute",
        { supplierId: supplier.id, supplierName: supplier.name, reference, reason: `Shipment ${riskLabel}${refText}` },
        "Escalate the delay with the supplier",
        true,
      ),
    ],
    issue: {
      kind: "supplier",
      title: `Supplier delay${refText}`,
      detail,
      severity: "warning",
    },
    supplierDelayEvent: { supplierId: supplier.id, supplierName: supplier.name, reference, detail },
    approvalToolUse: {
      name: "business_disputeSupplier",
      input: { supplierId: supplier.id, supplierName: supplier.name, reference, reason: `Shipment ${riskLabel}${refText}` },
    },
    escalationReason: "A delayed supplier affects downstream fulfillments; a human should decide whether to dispute or re-plan.",
  };
}

/** Honest needs_info when the supplier reference matches nothing in the directory. */
function supplierNotFoundVerdict(supplierName: string, why: string): Verdict {
  return {
    status: "needs_info",
    summary: `I could not confirm anything about a supplier named "${supplierName}" — ${why}. No delay and no dispute was recorded, and no customer was contacted.`,
    priority: "low",
    confidence: "medium",
    findings: [
      {
        kind: "supplier",
        title: "Supplier not found",
        detail: `The supplier directory returned no match for "${supplierName}".`,
        severity: "warning",
      },
    ],
    recommendedActions: [],
    escalationReason: "Supplier reference did not match the directory; verify the name before acting on the email.",
  };
}

/**
 * Emits the structured result as a fenced JSON block (mirroring the real
 * gateway's contract). The agent core parses it and overrides `actions` with
 * ground truth from what actually ran.
 */
function toFinalText(verdict: Verdict, intent = "Investigate the order and determine the correct operations response."): string {
  const envelope = {
    status: verdict.status,
    summary: verdict.summary,
    intent,
    priority: verdict.priority,
    confidence: verdict.confidence,
    findings: verdict.findings,
    recommendedActions: verdict.recommendedActions,
    requiresHumanApproval: verdict.recommendedActions.some((a) => a.requiresApproval),
    escalationReason: verdict.escalationReason,
  };
  return `\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
}

const SUPPLIER_INTENT = "Investigate the supplier situation and determine the correct operations response.";

export class ScriptedLlmGateway implements LlmGateway {
  readonly id = "scripted";
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  complete(req: LlmRequest): Promise<LlmResponse> {
    const tools = new Set(req.tools.map((t) => t.name));
    const ctx = readContext(req.transcript);

    if (ctx.taskType === "supplier-email") {
      return Promise.resolve(this.supplierStep(req, ctx, tools));
    }

    const order = lastResult(req.transcript, "shopify_getOrder") as Order | null | undefined;
    const search = lastResult(req.transcript, "shopify_searchOrders");

    // Phase 1 — locate the order. Enter only while we have not located one
    // (getOrder by id or searchOrders by email/text). Once an order object is
    // ours, never re-enter — missing search results must not mask it.
    if (order === undefined && search === undefined) {
      if (ctx.orderId && tools.has("shopify_getOrder") && order === undefined) {
        return Promise.resolve({ text: "", toolUses: [toolUse("shopify_getOrder", { id: ctx.orderId })] });
      }
      if (!ctx.orderId && tools.has("shopify_searchOrders") && search === undefined) {
        // Prefer the customer's email to identify them; else an order reference
        // literally written in the message (e.g. "#1001"); else the raw text.
        const q = ctx.customerEmail ?? orderRef(ctx.text) ?? ctx.text;
        if (q) {
          return Promise.resolve({ text: "", toolUses: [toolUse("shopify_searchOrders", { query: q, limit: 5 })] });
        }
      }
      return Promise.resolve({ text: toFinalText(noOrderVerdict(req, search)), toolUses: [] });
    }

    // Order found (or lastResult returned null → not found).
    let current: Order | null;
    if (order) {
      current = order;
    } else if (Array.isArray(search) && search.length > 0) {
      current = (search as Order[])[0];
    } else {
      return Promise.resolve({ text: toFinalText(noOrderVerdict(req, search)), toolUses: [] });
    }

    // Phase 2 — fetch shipment detail when the order has been fulfilled (even partially).
    const wantsFulfillment =
      current.fulfillmentStatus === "fulfilled" ||
      current.fulfillmentStatus === "partial" ||
      (current.fulfillmentStatus === null && ctx.orderId !== undefined);
    const fulfillmentResult = lastResult(req.transcript, "shopify_getFulfillment");
    if (wantsFulfillment && fulfillmentResult === undefined && tools.has("shopify_getFulfillment")) {
      return Promise.resolve({ text: "", toolUses: [toolUse("shopify_getFulfillment", { orderId: current!.id })] });
    }

    const fulfillments = (Array.isArray(fulfillmentResult) ? fulfillmentResult : []) as Fulfillment[];
    const verdict = classify(current!, fulfillments);

    // Phase 3 — act on the verdict before finalizing.
    if (verdict.issue && !hasProposed(req.transcript, "internal_createIssue") && tools.has("internal_createIssue")) {
      return Promise.resolve({
        text: "",
        toolUses: [toolUse("internal_createIssue", { ...verdict.issue })],
      });
    }
    if (verdict.approvalToolUse && !hasProposed(req.transcript, verdict.approvalToolUse.name) && tools.has(verdict.approvalToolUse.name)) {
      return Promise.resolve({
        text: "",
        toolUses: [toolUse(verdict.approvalToolUse.name, verdict.approvalToolUse.input)],
      });
    }

    // Slack reply: a customer messaged via Slack, so acknowledge on their
    // channel with the honest verdict summary. Only genuinely routine outcomes
    // qualify (resolved, no filed issue, nothing pending approval) — anything
    // sensitive stays behind the human gate, mirroring how
    // `send_routine_customer_update` is auto but `send_customer_email` is not.
    const replyChannel =
      typeof ctx.metadata?.["channel"] === "string" && ctx.metadata["channel"] !== ""
        ? (ctx.metadata["channel"] as string)
        : null;
    if (
      ctx.taskType === "slack-message" &&
      replyChannel !== null &&
      verdict.status === "resolved" &&
      !verdict.issue &&
      !verdict.approvalToolUse &&
      !hasProposed(req.transcript, "slack_postMessage") &&
      tools.has("slack_postMessage")
    ) {
      return Promise.resolve({
        text: "",
        toolUses: [toolUse("slack_postMessage", { channel: replyChannel, text: verdict.summary })],
      });
    }

    this.logger.debug({ order: current!.name }, "scripted gateway verdict");
    return Promise.resolve({ text: toFinalText(verdict), toolUses: [] });
  }

  /**
   * Supplier-email SOP: look the supplier up, then act on what the directory says.
   * The supplier name comes from the email metadata — never guessed from prose.
   */
  private supplierStep(req: LlmRequest, ctx: TaskContext, tools: Set<string>): LlmResponse {
    const supplierName =
      typeof ctx.metadata?.["supplierName"] === "string" && ctx.metadata["supplierName"] !== ""
        ? (ctx.metadata["supplierName"] as string)
        : (ctx.text ?? "").slice(0, 80);

    const lookup = lastResult(req.transcript, "supplier_lookup") as Supplier | null | undefined;

    // Phase 1 — consult the directory (once).
    if (lookup === undefined) {
      if (!tools.has("supplier_lookup")) {
        return { text: toFinalText(supplierNotFoundVerdict(supplierName, "the supplier directory is not available"), SUPPLIER_INTENT), toolUses: [] };
      }
      return { text: "", toolUses: [toolUse("supplier_lookup", { name: supplierName })] };
    }
    if (lookup === null) {
      return { text: toFinalText(supplierNotFoundVerdict(supplierName, "the directory returned no match"), SUPPLIER_INTENT), toolUses: [] };
    }

    const verdict = classifySupplier(lookup, ctx);

    // Phase 2 — file it, record the audited delay event, then propose the dispute.
    if (verdict.issue && !hasProposed(req.transcript, "internal_createIssue") && tools.has("internal_createIssue")) {
      return { text: "", toolUses: [toolUse("internal_createIssue", { ...verdict.issue })] };
    }
    if (
      verdict.supplierDelayEvent &&
      !hasProposed(req.transcript, "internal_recordSupplierDelay") &&
      tools.has("internal_recordSupplierDelay")
    ) {
      const { supplierId, supplierName: name, reference, detail } = verdict.supplierDelayEvent;
      return {
        text: "",
        toolUses: [toolUse("internal_recordSupplierDelay", { supplierId, supplierName: name, reference, detail })],
      };
    }
    if (verdict.approvalToolUse && !hasProposed(req.transcript, verdict.approvalToolUse.name) && tools.has(verdict.approvalToolUse.name)) {
      return { text: "", toolUses: [toolUse(verdict.approvalToolUse.name, verdict.approvalToolUse.input)] };
    }

    this.logger.debug({ supplier: lookup.name, risk: lookup.risk }, "scripted gateway supplier verdict");
    return { text: toFinalText(verdict, SUPPLIER_INTENT), toolUses: [] };
  }
}

/** Honest needs_info when we could not identify or locate the order. */
function noOrderVerdict(_req: LlmRequest, search: unknown): Verdict {
  if (Array.isArray(search) && search.length === 0) {
    return {
      status: "needs_info",
      summary: "No matching order was found for the reference provided. I have not assumed an order exists.",
      priority: "low",
      confidence: "high",
      findings: [{ kind: "order", title: "Order not found", detail: "The search returned no orders matching the given details.", severity: "warning" }],
      recommendedActions: [],
      escalationReason: "The customer reference does not match any order; verify the order number before replying.",
    };
  }
  return {
    status: "needs_info",
    summary: "I could not identify the order from the information provided. Nothing has been changed.",
    priority: "low",
    confidence: "medium",
    findings: [],
    recommendedActions: [],
    escalationReason: "Insufficient information to investigate — an operator should request the order number or email.",
  };
}

export { FENCE };