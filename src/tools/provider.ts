import type { z } from "zod";
import type { Logger } from "../lib/logger.ts";
import type { Repository } from "../domain/repository.ts";
import type { ActionKind } from "../domain/types.ts";

/**
 * Tool boundary. Every business system exposes tool definitions; the registry
 * aggregates them for the agent and writes each dispatch to the audit log.
 */
export interface ToolContext {
  taskId: string;
  step: number;
  logger: Logger;
  repo: Repository;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** The deterministic permission tier this tool is evaluated against. */
  actionKind: ActionKind;
  inputSchema: z.ZodType;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolProvider {
  readonly id: string;
  readonly label: string;
  listTools(): ToolDefinition[];
}