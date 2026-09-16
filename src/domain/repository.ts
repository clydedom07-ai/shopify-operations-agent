import type {
  ActionLogRow,
  AgentEvent,
  AgentEventType,
  Approval,
  ApprovalStatus,
  Issue,
  IssueStatus,
  PermissionMode,
  RecommendedAction,
  Task,
  TaskInput,
  TaskStatus,
} from "./types.ts";

export interface TaskCreateInput {
  type: Task["type"];
  input: TaskInput;
  priority?: Task["priority"];
  status?: TaskStatus;
}

export interface Repository {
  // tasks
  createTask(input: TaskCreateInput, taskId?: string): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(filter?: { status?: TaskStatus; type?: Task["type"]; limit?: number }): Promise<Task[]>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  /** running -> pending for tasks whose start predates `timeoutMs` (crash recovery). */
  requeueRunning(timeoutMs?: number): Promise<number>;
  /** atomically claim one pending task for the worker queue. */
  claimNextTask(maxAttempts: number): Promise<Task | null>;

  // audit trail
  appendActionLog(
    row: Pick<ActionLogRow, "taskId" | "step" | "tool" | "actionKind" | "mode" | "input" | "output" | "isError" | "durationMs">,
  ): Promise<ActionLogRow>;
  listActionLogs(filter?: { taskId?: string; limit?: number }): Promise<ActionLogRow[]>;

  // issues
  createIssue(
    issue: Omit<Issue, "id" | "createdAt" | "status" | "resolvedAt"> & { status?: IssueStatus; taskId?: string | null },
  ): Promise<Issue>;
  getIssue(id: string): Promise<Issue | null>;
  listIssues(filter?: { status?: IssueStatus; kind?: string; limit?: number }): Promise<Issue[]>;
  updateIssue(id: string, patch: Partial<Issue>): Promise<Issue>;

  // human-in-the-loop approvals
  createApproval(
    approval: Pick<Approval, "taskId" | "actionKind" | "tool" | "rationale" | "input"> & {
      issueId?: string | null;
      status?: ApprovalStatus;
    },
  ): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(filter?: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]>;
  updateApproval(id: string, patch: Partial<Approval>): Promise<Approval>;

  // events
  recordEvent(event: { type: AgentEventType; payload: Record<string, unknown>; source: string }): Promise<AgentEvent>;
  listEvents(filter?: { type?: AgentEventType; limit?: number }): Promise<AgentEvent[]>;
}

export type { PermissionMode, RecommendedAction, TaskInput as TaskRequestBody };