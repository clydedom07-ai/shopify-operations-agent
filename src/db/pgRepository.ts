import pg from "pg";
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

type Row = Record<string, unknown>;

// JSONB columns come back as parsed JS values; timestamps as Date objects.
const mapTask = (r: Row): Task => ({
  id: String(r.id),
  type: r.type as Task["type"],
  status: r.status as TaskStatus,
  input: r.input as Task["input"],
  result: (r.result as Task["result"]) ?? null,
  error: (r.error as Task["error"]) ?? null,
  currentStep: (r.current_step as string | null) ?? null,
  priority: (r.priority as Task["priority"]) ?? null,
  attempts: Number(r.attempts),
  startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
  completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
  createdAt: new Date(r.created_at as string).toISOString(),
  updatedAt: new Date(r.updated_at as string).toISOString(),
});

const mapActionLog = (r: Row): ActionLogRow => ({
  id: String(r.id),
  taskId: String(r.task_id),
  step: Number(r.step),
  tool: String(r.tool),
  actionKind: r.action_kind as ActionLogRow["actionKind"],
  mode: r.mode as ActionLogRow["mode"],
  input: (r.input as ActionLogRow["input"]) ?? {},
  output: r.output ?? null,
  isError: Boolean(r.is_error),
  durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
  createdAt: new Date(r.created_at as string).toISOString(),
});

const mapIssue = (r: Row): Issue => {
  const rec = r.recommended_action as Issue["recommendedAction"];
  return {
    id: String(r.id),
    kind: String(r.kind),
    title: String(r.title),
    detail: String(r.detail),
    severity: r.severity as Issue["severity"],
    status: r.status as IssueStatus,
    taskId: r.task_id ? String(r.task_id) : null,
    recommendedAction: rec ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at as string).toISOString() : null,
  };
};

const mapApproval = (r: Row): Approval => ({
  id: String(r.id),
  taskId: String(r.task_id),
  issueId: r.issue_id ? String(r.issue_id) : null,
  actionKind: r.action_kind as Approval["actionKind"],
  tool: String(r.tool),
  rationale: String(r.rationale),
  input: (r.input as Approval["input"]) ?? {},
  status: r.status as ApprovalStatus,
  decidedBy: r.decided_by ? String(r.decided_by) : null,
  decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
  createdAt: new Date(r.created_at as string).toISOString(),
});

const mapEvent = (r: Row): AgentEvent => ({
  id: String(r.id),
  type: r.type as AgentEventType,
  payload: (r.payload as AgentEvent["payload"]) ?? {},
  source: String(r.source ?? ""),
  receivedAt: new Date(r.received_at as string).toISOString(),
});

const TASK_PATCH_COLUMNS: Record<string, keyof Task> = {
  status: "status",
  result: "result",
  error: "error",
  current_step: "currentStep",
  priority: "priority",
  attempts: "attempts",
  started_at: "startedAt",
  completed_at: "completedAt",
};

/**
 * Postgres-backed repository. Connection comes from DATABASE_URL so the same
 * code runs against local docker Postgres or Supabase. Not injectable in place
 * of {@link InMemoryRepository} without changing callers.
 */
export class PgRepository implements Repository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ── tasks ──
  async createTask(input: TaskCreateInput, taskId?: string): Promise<Task> {
    // An explicit NULL would bypass the id's DEFAULT gen_random_uuid() (real
    // Postgres behavior: defaults fire only when the column is omitted), so
    // omit the column when no id is given. Caught by the live-DB probe, not by
    // in-memory tests, which generate their own UUIDs.
    const sql = taskId === undefined
      ? `INSERT INTO tasks (type, status, input, priority) VALUES ($1, $2, $3, $4) RETURNING *`
      : `INSERT INTO tasks (type, status, input, priority, id) VALUES ($1, $2, $3, $4, $5) RETURNING *`;
    const params = taskId === undefined
      ? [input.type, input.status ?? "pending", JSON.stringify(input.input), input.priority ?? null]
      : [input.type, input.status ?? "pending", JSON.stringify(input.input), input.priority ?? null, taskId];
    const { rows } = await this.pool.query(sql, params);
    return mapTask(rows[0]);
  }

  async getTask(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async listTasks(filter?: { status?: TaskStatus; type?: Task["type"]; limit?: number }): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    params.push(filter?.limit ?? 100);
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapTask);
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const col of Object.keys(TASK_PATCH_COLUMNS)) {
      const field = TASK_PATCH_COLUMNS[col];
      if (patch[field] === undefined) continue;
      params.push(patch[field] as never);
      sets.push(`${col} = $${params.length}`);
    }
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    const { rows } = await this.pool.query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!rows[0]) throw new Error(`Task not found: ${id}`);
    return mapTask(rows[0]);
  }

  async requeueRunning(timeoutMs = 30_000): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = now()
       WHERE status = 'running'
         AND (started_at IS NULL OR started_at < now() - make_interval(secs => $1::double precision * 0.001))`,
      [timeoutMs],
    );
    return rowCount ?? 0;
  }

  async claimNextTask(maxAttempts: number): Promise<Task | null> {
    const { rows } = await this.pool.query(
      `WITH candidate AS (
         SELECT id FROM tasks
         WHERE status = 'pending' AND attempts < $1
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE tasks SET status = 'running', attempts = attempts + 1,
              started_at = now(), updated_at = now()
       FROM candidate WHERE tasks.id = candidate.id
       RETURNING tasks.*`,
      [maxAttempts],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  // ── audit trail ──
  async appendActionLog(
    row: Parameters<Repository["appendActionLog"]>[0],
  ): Promise<ActionLogRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO action_logs (task_id, step, tool, action_kind, mode, input, output, is_error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        row.taskId,
        row.step,
        row.tool,
        row.actionKind,
        row.mode,
        JSON.stringify(row.input),
        row.output != null ? JSON.stringify(row.output) : null,
        row.isError,
        row.durationMs ?? null,
      ],
    );
    return mapActionLog(rows[0]);
  }

  async listActionLogs(filter?: { taskId?: string; limit?: number }): Promise<ActionLogRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.taskId) {
      params.push(filter.taskId);
      where.push(`task_id = $${params.length}`);
    }
    params.push(filter?.limit ?? 200);
    const sql = `SELECT * FROM action_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapActionLog);
  }

  // ── issues ──
  async createIssue(
    issue: Omit<Issue, "id" | "createdAt" | "status" | "resolvedAt"> & { status?: IssueStatus; taskId?: string | null },
  ): Promise<Issue> {
    const { rows } = await this.pool.query(
      `INSERT INTO issues (kind, title, detail, severity, status, task_id, recommended_action)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        issue.kind,
        issue.title,
        issue.detail,
        issue.severity,
        issue.status ?? "open",
        issue.taskId ?? null,
        issue.recommendedAction ? JSON.stringify(issue.recommendedAction) : null,
      ],
    );
    return mapIssue(rows[0]);
  }

  async getIssue(id: string): Promise<Issue | null> {
    const { rows } = await this.pool.query(`SELECT * FROM issues WHERE id = $1`, [id]);
    return rows[0] ? mapIssue(rows[0]) : null;
  }

  async listIssues(filter?: { status?: IssueStatus; kind?: string; limit?: number }): Promise<Issue[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.kind) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    params.push(filter?.limit ?? 100);
    const sql = `SELECT * FROM issues ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapIssue);
  }

  async updateIssue(id: string, patch: Partial<Issue>): Promise<Issue> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const value = (field: keyof Issue, col: string, value: unknown) => {
      if (patch[field] === undefined) return;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    value("kind", "kind", patch.kind);
    value("title", "title", patch.title);
    value("detail", "detail", patch.detail);
    value("severity", "severity", patch.severity);
    value("status", "status", patch.status);
    value("taskId", "task_id", patch.taskId ?? null);
    value("recommendedAction", "recommended_action", patch.recommendedAction ? JSON.stringify(patch.recommendedAction) : null);
    value("resolvedAt", "resolved_at", patch.resolvedAt ?? null);
    const { rows } = await this.pool.query(`UPDATE issues SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new Error(`Issue not found: ${id}`);
    return mapIssue(rows[0]);
  }

  // ── approvals ──
  async createApproval(
    approval: Pick<Approval, "taskId" | "actionKind" | "tool" | "rationale" | "input"> & {
      issueId?: string | null;
      status?: ApprovalStatus;
    },
  ): Promise<Approval> {
    const { rows } = await this.pool.query(
      `INSERT INTO approvals (task_id, issue_id, action_kind, tool, rationale, input, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        approval.taskId,
        approval.issueId ?? null,
        approval.actionKind,
        approval.tool,
        approval.rationale,
        JSON.stringify(approval.input),
        approval.status ?? "pending",
      ],
    );
    return mapApproval(rows[0]);
  }

  async getApproval(id: string): Promise<Approval | null> {
    const { rows } = await this.pool.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  async listApprovals(filter?: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(filter?.limit ?? 100);
    const sql = `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapApproval);
  }

  async updateApproval(id: string, patch: Partial<Approval>): Promise<Approval> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const value = (field: keyof Approval, col: string, value: unknown) => {
      if (patch[field] === undefined) return;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    value("actionKind", "action_kind", patch.actionKind);
    value("status", "status", patch.status);
    value("decidedBy", "decided_by", patch.decidedBy ?? null);
    value("decidedAt", "decided_at", patch.decidedAt ?? null);
    value("rationale", "rationale", patch.rationale);
    const { rows } = await this.pool.query(`UPDATE approvals SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new Error(`Approval not found: ${id}`);
    return mapApproval(rows[0]);
  }

  // ── events ──
  async recordEvent(event: { type: AgentEventType; payload: Record<string, unknown>; source: string }): Promise<AgentEvent> {
    const { rows } = await this.pool.query(
      `INSERT INTO events (type, payload, source) VALUES ($1, $2, $3) RETURNING *`,
      [event.type, JSON.stringify(event.payload), event.source],
    );
    return mapEvent(rows[0]);
  }

  async listEvents(filter?: { type?: AgentEventType; limit?: number }): Promise<AgentEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    params.push(filter?.limit ?? 100);
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(mapEvent);
  }
}