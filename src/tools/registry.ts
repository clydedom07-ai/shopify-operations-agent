import type { Logger } from "../lib/logger.ts";
import type { ActionLogRow, ActionKind } from "../domain/types.ts";
import { PermissionResolver } from "../domain/permissions.ts";
import type { ToolContext, ToolDefinition, ToolProvider } from "./provider.ts";

export type ToolDispatch =
  | { ok: true; result: unknown; actionLog: ActionLogRow }
  | { ok: false; error: string; actionLog?: ActionLogRow };

/**
 * Aggregates tool providers, dispatches by name, and writes one audit row per
 * call (`action_logs` / task actions). The registry executes tools; it does not
 * decide authorization — the agent loop consults {@link PermissionResolver}
 * before dispatch and handles approval/blocked outcomes.
 */
export class ToolRegistry {
  private readonly providers: ToolProvider[] = [];
  private readonly byName = new Map<string, ToolDefinition>();
  private readonly logger: Logger;
  private readonly permissions: PermissionResolver;

  constructor(logger: Logger, permissions: PermissionResolver = new PermissionResolver()) {
    this.logger = logger;
    this.permissions = permissions;
  }

  register(provider: ToolProvider): this {
    this.providers.push(provider);
    for (const tool of provider.listTools()) {
      if (this.byName.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.byName.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  listTools(): ToolDefinition[] {
    return this.providers.flatMap((p) => p.listTools());
  }

  names(): string[] {
    return this.listTools().map((t) => t.name);
  }

  modeFor(actionKind: ActionKind) {
    return this.permissions.modeFor(actionKind);
  }

  async dispatch(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolDispatch> {
    const tool = this.byName.get(name);
    if (!tool) return { ok: false, error: `Unknown tool '${name}'` };

    const parsed = tool.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      this.logger.warn({ tool: name, detail }, "tool input rejected");
      return { ok: false, error: `Invalid input for '${name}': ${detail}` };
    }

    const args = parsed.data as Record<string, unknown>;
    const mode = this.permissions.modeFor(tool.actionKind);
    const startedAt = Date.now();
    try {
      const result = await tool.execute(ctx, args);
      const actionLog = await ctx.repo.appendActionLog({
        taskId: ctx.taskId,
        step: ctx.step,
        tool: tool.name,
        actionKind: tool.actionKind,
        mode,
        input: args,
        output: result,
        isError: false,
        durationMs: Date.now() - startedAt,
      });
      this.logger.debug({ tool: tool.name, taskId: ctx.taskId }, "tool dispatched");
      return { ok: true, result, actionLog };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const actionLog = await ctx.repo.appendActionLog({
        taskId: ctx.taskId,
        step: ctx.step,
        tool: tool.name,
        actionKind: tool.actionKind,
        mode,
        input: args,
        output: null,
        isError: true,
        durationMs: Date.now() - startedAt,
      });
      this.logger.warn({ tool: tool.name, taskId: ctx.taskId, error: message }, "tool dispatch failed");
      return { ok: false, error: message, actionLog };
    }
  }
}