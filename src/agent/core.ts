import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DEFAULT_MODES } from "../domain/permissions.ts";
import type {
  ActionKind,
  ActionRecord,
  AgentStatus,
  Finding,
  Priority,
  RecommendedAction,
  Task,
} from "../domain/types.ts";
import type { Repository } from "../domain/repository.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/provider.ts";
import { LlmRequestError, type LlmGateway, type LlmToolResult, type LlmToolSpec, type LlmTurn, type LlmToolUse } from "../llm/gateway.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * The agent loop. One task in, one structured result out.
 *
 * Guarantees that matter here:
 *  - The model PROPOSES tool uses; the deterministic permission table decides
 *    whether they run. `auto` runs, `approval` becomes a pending human Approval
 *    (never executed), `blocked` is refused. Model confidence is never an input.
 *  - `result.actions` is assembled from what actually happened (audited tool
 *    dispatches, pending approvals, refusals) — the model's own narration of
 *    what it did is never trusted, so actions cannot be invented.
 *  - Nothing is invented: if the model layer produced no valid structured
 *    verdict, only tool-observed facts and recorded actions are reported.
 */

export interface AgentDeps {
  registry: ToolRegistry;
  gateway: LlmGateway;
  repo: Repository;
  logger: Logger;
  maxSteps?: number;
}

const ACTION_KIND_SET: ReadonlySet<string> = new Set(Object.keys(DEFAULT_MODES));
const isActionKind = (v: string): v is ActionKind => ACTION_KIND_SET.has(v);

const SYSTEM_PROMPT = `You are the Shopify Operations Agent, an e-commerce operations specialist. You investigate orders and shipments, detect operational problems, and recommend — or propose — actions. A deterministic permission policy decides what actually runs, independent of you.

While investigating:
- Use the provided tools to gather facts about orders, customers, shipments, tracking, and inventory. Base every claim on a tool result you received.
- NEVER invent: order information, tracking numbers, delivery dates, refunds, discounts, supplier statements, or actions that were not actually performed. If information is unavailable, say so and recommend investigation or escalation instead of guessing.
- Distinguish shipment situations honestly: normal/in-transit, delayed (no recent scan), lost, exception, delivered-but-customer-disputes, or insufficient information.
- Rich-impact proposals (refund, replacement, discount, order modification, supplier dispute, policy exception, customer email) will be HELD for human approval when you propose them — never claim you performed them.

When your investigation is complete, end your turn with an assistant message whose ONLY content is a fenced JSON block exactly like this:
\`\`\`json
{"status":"resolved|needs_approval|needs_info|error","summary":"human-readable outcome","intent":"what you set out to do","priority":"low|medium|high","confidence":"low|medium|high","findings":[{"kind":"order|shipment|customer|inventory|supplier","title":"...","detail":"...","severity":"info|warning|critical"}],"recommendedActions":[{"tool":"<registered tool name>","actionKind":"<a known action kind>","input":{},"rationale":"...","requiresApproval":false}],"requiresHumanApproval":false,"escalationReason":"optional"}
\`\`\`
- status must reflect reality: needs_approval when a human decision is genuinely required, needs_info when you lack data, resolved when you handled it, error on failure.
- summary must be truthful and may only reference tool results you received.
- For a proactive (non-customer) check, actively scan for problems — orders stuck unfulfilled, dormant tracking — and propose creating issues / internal notifications.`;

const resultSchema = z.object({
  status: z.enum(["resolved", "needs_approval", "needs_info", "error"]),
  summary: z.string().min(1),
  intent: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]),
  confidence: z.string().optional(),
  findings: z
    .array(
      z.object({
        kind: z.string().min(1),
        title: z.string().min(1),
        detail: z.string().default(""),
        severity: z.enum(["info", "warning", "critical"]).default("info"),
      }),
    )
    .default([]),
  recommendedActions: z
    .array(
      z.object({
        tool: z.string().min(1),
        actionKind: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
        rationale: z.string().default(""),
        requiresApproval: z.boolean().default(false),
      }),
    )
    .default([]),
  requiresHumanApproval: z.boolean().default(false),
  escalationReason: z.string().optional(),
});

type Envelope = z.infer<typeof resultSchema>;

const FENCE = /```json\s*([\s\S]*?)```/;

interface LoopState {
  actions: ActionRecord[];
  facts: unknown[];
}

function taskContextJson(task: Task): string {
  return JSON.stringify({
    taskType: task.type,
    text: task.input.text,
    orderId: task.input.orderId ?? null,
    customerEmail: task.input.customerEmail ?? null,
    eventType: task.input.eventType ?? null,
    metadata: task.input.metadata ?? null,
  });
}

export async function runAgentTask(task: Task, deps: AgentDeps) {
  const { registry, gateway, repo, logger } = deps;
  const maxSteps = deps.maxSteps ?? 12;

  const transcript: LlmTurn[] = [{ role: "user", text: taskContextJson(task) }];
  const tools: LlmToolSpec[] = registry.listTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { $refStrategy: "none" }) as Record<string, unknown>,
  }));

  const state: LoopState = { actions: [], facts: [] };
  let finalText = "";

  for (let step = 1; step <= maxSteps; step++) {
    await repo.updateTask(task.id, { currentStep: `step ${step}: investigating` });
    let res;
    try {
      res = await gateway.complete({ system: SYSTEM_PROMPT, transcript, tools });
    } catch (err) {
      logger.warn({ taskId: task.id, error: err instanceof Error ? err.message : String(err) }, "llm call failed");
      throw err instanceof LlmRequestError
        ? err
        : new LlmRequestError("LLM backend failed for the current task", false);
    }

    if (res.toolUses.length === 0) {
      finalText = res.text;
      break;
    }

    const ctx: ToolContext = { taskId: task.id, step, logger, repo };
    const toolResults: LlmToolResult[] = [];
    for (const use of res.toolUses) {
      toolResults.push(await handleUse(use, ctx, state, deps));
    }
    transcript.push({ role: "assistant", text: res.text, toolUses: res.toolUses });
    transcript.push({ role: "user", toolResults });

    if (step === maxSteps) {
      logger.warn({ taskId: task.id }, "maxSteps reached; finalizing from recorded state");
      finalText = res.text;
    }
  }

  await repo.updateTask(task.id, { currentStep: "finalizing" });
  return assembleResult(task, finalText, state, deps);
}

/** Run — or safely decline — one proposed tool use under the permission policy. */
async function handleUse(use: LlmToolUse, ctx: ToolContext, state: LoopState, deps: AgentDeps): Promise<LlmToolResult> {
  const def = deps.registry.get(use.name);
  if (!def) {
    deps.logger.warn({ taskId: ctx.taskId, tool: use.name }, "model proposed an unknown tool; nothing executed");
    return {
      id: use.id,
      name: use.name,
      result: { error: `Unknown tool '${use.name}' — nothing was executed.` },
      isError: true,
    };
  }

  const mode = deps.registry.modeFor(def.actionKind);
  const at = new Date().toISOString();

  if (mode === "auto") {
    const dispatched = await deps.registry.dispatch(use.name, use.input, ctx);
    state.actions.push({
      actionKind: def.actionKind,
      tool: def.name,
      mode,
      outcome: dispatched.ok ? "performed" : "failed",
      detail: dispatched.ok ? undefined : dispatched.error,
      at,
    });
    if (dispatched.ok) state.facts.push(dispatched.result);
    return {
      id: use.id,
      name: def.name,
      result: dispatched.ok ? dispatched.result : { error: dispatched.error },
      isError: !dispatched.ok,
    };
  }

  if (mode === "approval") {
    const approval = await ctx.repo.createApproval({
      taskId: ctx.taskId,
      actionKind: def.actionKind,
      tool: def.name,
      rationale: `Agent proposed ${def.name} and the permission policy requires human approval.`,
      input: use.input,
    });
    await ctx.repo.appendActionLog({
      taskId: ctx.taskId,
      step: ctx.step,
      tool: def.name,
      actionKind: def.actionKind,
      mode,
      input: use.input,
      output: { outcome: "needs_approval", approvalId: approval.id },
      isError: false,
      durationMs: null,
    });
    state.actions.push({
      actionKind: def.actionKind,
      tool: def.name,
      mode,
      outcome: "needs_approval",
      detail: approval.id,
      at,
    });
    return {
      id: use.id,
      name: def.name,
      result: {
        outcome: "needs_approval",
        approvalId: approval.id,
        message: "This action is awaiting a human approval decision and was NOT executed.",
      },
      isError: false,
    };
  }

  // blocked — deterministic refusal, still audited.
  await ctx.repo.appendActionLog({
    taskId: ctx.taskId,
    step: ctx.step,
    tool: def.name,
    actionKind: def.actionKind,
    mode,
    input: use.input,
    output: { outcome: "blocked" },
    isError: true,
    durationMs: null,
  });
  state.actions.push({
    actionKind: def.actionKind,
    tool: def.name,
    mode,
    outcome: "blocked",
    detail: "Permission policy forbids this action",
    at,
  });
  return {
    id: use.id,
    name: def.name,
    result: { outcome: "blocked", message: "This action is blocked by permission policy and was NOT executed." },
    isError: true,
  };
}

function assembleResult(task: Task, finalText: string, state: LoopState, deps: AgentDeps) {
  const parsed = parseEnvelope(finalText);
  const defaultIntent = `Investigate ${task.type}${task.input.orderId ? ` for order ${task.input.orderId}` : ""}`;

  let status: AgentStatus;
  let summary: string;
  let intent = defaultIntent;
  let priority: Priority = "low";
  let confidence: string | undefined;
  let findings: Finding[] = [];
  let recommendedActions: RecommendedAction[] = [];
  let escalationReason: string | undefined;

  if (parsed.ok) {
    const e = parsed.envelope;
    status = e.status;
    summary = e.summary;
    intent = e.intent ?? defaultIntent;
    priority = e.priority;
    confidence = e.confidence;
    findings = e.findings.slice(0, 40).map((f) => ({ id: randomUUID(), source: "llm", ...f }));
    recommendedActions = e.recommendedActions
      .filter((a) => isActionKind(a.actionKind) && deps.registry.get(a.tool) !== undefined)
      .slice(0, 20)
      .map((a) => ({ ...a, actionKind: a.actionKind as ActionKind }));
    escalationReason = e.escalationReason;
  } else {
    const hasApproval = state.actions.some((a) => a.outcome === "needs_approval");
    status = hasApproval ? "needs_approval" : "error";
    summary =
      finalText.trim() ||
      "The agent completed its investigation but no structured verdict was produced. Only recorded actions and tool-observed facts are reported below.";
    findings = factsToFindings(state.facts);
    confidence = "information";
    priority = "medium";
    escalationReason = "No structured verdict on record; findings/actions reflect tool outputs only.";
  }

  const requiresHumanApproval =
    state.actions.some((a) => a.outcome === "needs_approval") ||
    recommendedActions.some((a) => a.requiresApproval);

  if (requiresHumanApproval && status !== "error") status = "needs_approval";

  return {
    status,
    summary,
    intent,
    priority,
    confidence,
    findings,
    actions: state.actions,
    recommendedActions,
    requiresHumanApproval,
    escalationReason,
  };
}

function parseEnvelope(text: string): { ok: true; envelope: Envelope } | { ok: false } {
  const candidate = FENCE.exec(text)?.[1] ?? (/^\s*\{[\s\S]*\}\s*$/.test(text) ? text : null);
  if (!candidate) return { ok: false };
  try {
    const parsed = resultSchema.safeParse(JSON.parse(candidate));
    if (parsed.success) return { ok: true, envelope: parsed.data };
  } catch {
    // fall through
  }
  return { ok: false };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Minimal, entirely tool-derived findings used when no structured verdict exists. */
function factsToFindings(facts: unknown[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of facts) {
    if (isObject(f) && typeof f.id === "string") {
      if (typeof f.name === "string" && typeof f.financialStatus === "string") {
        findings.push({
          id: randomUUID(),
          kind: "order",
          title: `Order ${f.name}`,
          detail: `${f.financialStatus} / ${f.fulfillmentStatus ?? "no fulfillment record"}.`,
          severity: "info",
          source: "tool",
          data: { id: f.id, name: f.name },
        });
      } else if (typeof f.trackingNumber === "string" && typeof f.status === "string") {
        const events = Array.isArray(f.trackingEvents) ? (f.trackingEvents as Array<{ status?: string }>) : [];
        findings.push({
          id: randomUUID(),
          kind: "shipment",
          title: `Shipment ${f.trackingNumber}`,
          detail: `Status ${f.status}${events.length ? `; latest scan ${events[events.length - 1].status ?? "n/a"}.` : ""}`,
          severity: "info",
          source: "tool",
          data: { id: f.id, trackingNumber: f.trackingNumber },
        });
      }
    }
  }
  return findings.slice(0, 40);
}