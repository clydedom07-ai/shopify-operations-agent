import type { StructuredResult, Task } from "../domain/types.ts";
import type { Logger } from "../lib/logger.ts";
import { buildN8nCallbackPayload, type N8nNotifyResult, type N8nWebhookClient } from "./types.ts";

export interface N8nCallbackContext {
  client: N8nWebhookClient;
  logger: Logger;
}

/**
 * Fire the post-completion n8n callback for a finished task: build the
 * truth-derived payload and POST it. A failure never throws — it is logged and
 * returned so orchestration keeps running while ops sees the gap in JSON logs.
 */
export async function n8nCallbackTaskCompletion(
  task: Task,
  result: StructuredResult,
  ctx: N8nCallbackContext,
): Promise<N8nNotifyResult> {
  const payload = buildN8nCallbackPayload(task, result);
  // Spread into a plain object: the client's wire contract is permissive
  // Record<string, unknown>, while the payload stays a typed producer.
  const outcome = await ctx.client.notify({ ...payload });
  if (outcome.ok) {
    ctx.logger.info(
      { taskId: task.id, status: result.status, webhook: ctx.client.id },
      "n8n callback delivered",
    );
  } else {
    ctx.logger.warn(
      { taskId: task.id, status: result.status, webhook: ctx.client.id, error: outcome.error },
      "n8n callback failed",
    );
  }
  return outcome;
}