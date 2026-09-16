import { randomUUID } from "node:crypto";
import type {
  ActionLogRow,
  AgentEvent,
  AgentEventType,
  Approval,
  ApprovalStatus,
  Issue,
  IssueStatus,
  Task,
  TaskStatus,
} from "../domain/types.ts";
import type { Repository, TaskCreateInput } from "../domain/repository.ts";

/**
 * In-memory repository. Mirrors Postgres semantics closely enough for tests and
 * for running the agent with zero infrastructure. Nothing persists across
 * restarts — use PgRepository in production.
 */
export class InMemoryRepository implements Repository {
  private tasks = new Map<string, Task>();
  private actionLogs: ActionLogRow[] = [];
  private issues = new Map<string, Issue>();
  private approvals = new Map<string, Approval>();
  private events: AgentEvent[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  // ── tasks ──
  async createTask(input: TaskCreateInput, taskId: string = randomUUID()): Promise<Task> {
    const t: Task = {
      id: taskId,
      type: input.type,
      status: input.status ?? "pending",
      input: { ...input.input, metadata: { ...input.input.metadata } },
      priority: input.priority ?? null,
      attempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.tasks.set(t.id, t);
    return t;
  }

  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }

  async listTasks(filter?: { status?: TaskStatus; type?: Task["type"]; limit?: number }): Promise<Task[]> {
    let rows = [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.type) rows = rows.filter((r) => r.type === filter.type);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Task not found: ${id}`);
    const next: Task = { ...t, ...patch, id, createdAt: t.createdAt, updatedAt: this.now() };
    this.tasks.set(id, next);
    return next;
  }

  async requeueRunning(timeoutMs = 30_000): Promise<number> {
    const cutoff = Date.now() - timeoutMs;
    let count = 0;
    for (const [id, t] of this.tasks) {
      const startedMs = t.startedAt ? Date.parse(t.startedAt) : NaN;
      if (t.status === "running" && (Number.isNaN(startedMs) || startedMs < cutoff)) {
        this.tasks.set(id, { ...t, status: "pending", startedAt: null, updatedAt: this.now() });
        count += 1;
      }
    }
    return count;
  }

  async claimNextTask(maxAttempts: number): Promise<Task | null> {
    const candidates = [...this.tasks.values()]
      .filter((t) => t.status === "pending" && t.attempts < maxAttempts)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const t = candidates[0];
    if (!t) return null;
    const next: Task = { ...t, status: "running", attempts: t.attempts + 1, startedAt: this.now(), updatedAt: this.now() };
    this.tasks.set(t.id, next);
    return next;
  }

  // ── audit trail ──
  async appendActionLog(
    row: Omit<ActionLogRow, "id" | "createdAt">,
  ): Promise<ActionLogRow> {
    const full: ActionLogRow = { ...row, id: randomUUID(), createdAt: this.now() };
    this.actionLogs.push(full);
    return full;
  }

  async listActionLogs(filter?: { taskId?: string; limit?: number }): Promise<ActionLogRow[]> {
    let rows = this.actionLogs.filter((r) => !filter?.taskId || r.taskId === filter.taskId);
    rows = rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (filter?.limit) rows = rows.slice(-filter.limit);
    return rows;
  }

  // ── issues ──
  async createIssue(
    issue: Omit<Issue, "id" | "createdAt" | "status" | "resolvedAt"> & { status?: IssueStatus; taskId?: string | null },
  ): Promise<Issue> {
    const full: Issue = {
      id: randomUUID(),
      kind: issue.kind,
      title: issue.title,
      detail: issue.detail,
      severity: issue.severity,
      status: issue.status ?? "open",
      taskId: issue.taskId ?? null,
      recommendedAction: issue.recommendedAction ?? null,
      createdAt: this.now(),
      resolvedAt: null,
    };
    this.issues.set(full.id, full);
    return full;
  }

  async getIssue(id: string): Promise<Issue | null> {
    return this.issues.get(id) ?? null;
  }

  async listIssues(filter?: { status?: IssueStatus; kind?: string; limit?: number }): Promise<Issue[]> {
    let rows = [...this.issues.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.kind) rows = rows.filter((r) => r.kind === filter.kind);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }

  async updateIssue(id: string, patch: Partial<Issue>): Promise<Issue> {
    const i = this.issues.get(id);
    if (!i) throw new Error(`Issue not found: ${id}`);
    const next: Issue = { ...i, ...patch, id, createdAt: i.createdAt };
    this.issues.set(id, next);
    return next;
  }

  // ── approvals ──
  async createApproval(
    approval: Pick<Approval, "taskId" | "actionKind" | "tool" | "rationale" | "input"> & {
      issueId?: string | null;
      status?: ApprovalStatus;
    },
  ): Promise<Approval> {
    const full: Approval = {
      id: randomUUID(),
      taskId: approval.taskId,
      issueId: approval.issueId ?? null,
      actionKind: approval.actionKind,
      tool: approval.tool,
      rationale: approval.rationale,
      input: approval.input,
      status: approval.status ?? "pending",
      decidedBy: null,
      decidedAt: null,
      createdAt: this.now(),
    };
    this.approvals.set(full.id, full);
    return full;
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.approvals.get(id) ?? null;
  }

  async listApprovals(filter?: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]> {
    let rows = [...this.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }

  async updateApproval(id: string, patch: Partial<Approval>): Promise<Approval> {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`Approval not found: ${id}`);
    const next: Approval = { ...a, ...patch, id, createdAt: a.createdAt };
    this.approvals.set(id, next);
    return next;
  }

  // ── events ──
  async recordEvent(event: { type: AgentEventType; payload: Record<string, unknown>; source: string }): Promise<AgentEvent> {
    const full: AgentEvent = { id: randomUUID(), ...event, receivedAt: this.now() };
    this.events.push(full);
    return full;
  }

  async listEvents(filter?: { type?: AgentEventType; limit?: number }): Promise<AgentEvent[]> {
    let rows = [...this.events].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    if (filter?.type) rows = rows.filter((r) => r.type === filter.type);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }
}