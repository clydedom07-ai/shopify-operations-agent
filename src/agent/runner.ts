import type { AgentDeps } from "./core.ts";
import { runAgentTask } from "./core.ts";
import { LlmRequestError } from "../llm/gateway.ts";
import type { StructuredResult, Task } from "../domain/types.ts";
import type { Logger } from "../lib/logger.ts";

export interface RunnerOptions {
  /** Idle poll interval between drains. */
  claimIntervalMs?: number;
  /** A task is abandoned (crashed worker) after this; reclaimed on boot. */
  staleTimeoutMs?: number;
  /** Max attempts before a failing task is marked failed. */
  maxAttempts?: number;
  /**
   * Optional side effect fired after a task succeeds (e.g. the n8n callback).
   * Exceptions are caught and logged — a downstream webhook must never fail the
   * task that already succeeded.
   */
  onTaskComplete?: (task: Task, result: StructuredResult) => Promise<void>;
}

export function isRetryable(err: unknown): boolean {
  return err instanceof LlmRequestError && err.retryable;
}

/**
 * Task worker: claim → run → persist → requeue on retryable failure.
 * On boot it reclaims tasks a previous process died on, so work survives
 * restarts (the Postgres "tasks survive agent restarts" guarantee).
 */
export class AgentTaskRunner {
  private readonly deps: AgentDeps;
  private readonly logger: Logger;
  private readonly claimIntervalMs: number;
  private readonly staleTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly onTaskComplete: ((task: Task, result: StructuredResult) => Promise<void>) | undefined;
  private stopped = false;

  constructor(deps: AgentDeps, logger: Logger, opts: RunnerOptions = {}) {
    this.deps = deps;
    this.logger = logger;
    this.claimIntervalMs = opts.claimIntervalMs ?? 2_000;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.onTaskComplete = opts.onTaskComplete;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Requeue `running` tasks started before `staleTimeoutMs` (crash recovery). */
  async recoverRunning(): Promise<number> {
    const n = await this.deps.repo.requeueRunning(this.staleTimeoutMs);
    if (n > 0) this.logger.info({ requeued: n }, "recovered interrupted tasks from a previous run");
    return n;
  }

  /** Process one task end-to-end and persist the outcome. */
  async run(task: Task): Promise<void> {
    const log = this.logger.child({ taskId: task.id, type: task.type });
    try {
      const result = await runAgentTask(task, this.deps);
      await this.deps.repo.updateTask(task.id, {
        status: "succeeded",
        result,
        currentStep: "done",
        completedAt: new Date().toISOString(),
      });
      log.info(
        { status: result.status, requiresHumanApproval: result.requiresHumanApproval, actions: result.actions.length },
        "agent task succeeded",
      );
      if (this.onTaskComplete) {
        try {
          await this.onTaskComplete(task, result);
        } catch (err) {
          log.warn({ error: err instanceof Error ? err.message : String(err) }, "post-completion callback failed");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = isRetryable(err);
      const willRetry = retryable && task.attempts < this.maxAttempts;
      await this.deps.repo.updateTask(task.id, {
        status: willRetry ? "pending" : "failed",
        error: { message, category: retryable ? "llm_transient" : "agent_error", retryable },
        currentStep: willRetry ? "queued for retry" : "error",
        completedAt: willRetry ? undefined : new Date().toISOString(),
      });
      log.error({ error: message, retryable, willRetry }, "agent task failed");
    }
  }

  /** Drain every currently-claimable pending task. Returns how many ran. */
  async drainPending(): Promise<number> {
    let ran = 0;
    while (!this.stopped) {
      const task = await this.deps.repo.claimNextTask(this.maxAttempts);
      if (!task) break;
      await this.run(task);
      ran += 1;
    }
    return ran;
  }

  /** Long-running worker loop. Abort via `signal` or {@link AgentTaskRunner.stop}. */
  async start(signal?: AbortSignal): Promise<void> {
    await this.recoverRunning();
    this.logger.info({ intervalMs: this.claimIntervalMs }, "agent worker started");
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    while (!this.stopped && !signal?.aborted) {
      try {
        const ran = await this.drainPending();
        if (ran === 0) await sleep(this.claimIntervalMs);
      } catch (err) {
        this.logger.error({ error: err instanceof Error ? err.message : String(err) }, "worker drain failed");
        await sleep(this.claimIntervalMs * 5);
      }
    }
    this.logger.info("agent worker stopped");
  }
}