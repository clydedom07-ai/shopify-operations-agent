import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";
import type { N8nWebhookClient } from "../../n8n/types.ts";

const triggerWorkflow = z.object({
  workflow: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Lets the agent call INTO an n8n workflow mid-investigation (notify a channel,
 * kick a downstream step). Auto-tier: deterministic policy runs it, unlike the
 * approval-gated business actions. The webhook client is injectable, so the
 * mock records without network and the real client POSTs to the Webhook URL.
 */
export class N8nToolProvider implements ToolProvider {
  readonly id = "n8n";
  readonly label = "n8n workflows";

  private readonly client: N8nWebhookClient;

  constructor(client: N8nWebhookClient) {
    this.client = client;
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: "n8n_triggerWorkflow",
        description:
          "Trigger an n8n workflow webhook with a small payload (e.g. notify #ops). The workflow id must be an existing n8n webhook. Non-blocking on the agent loop.",
        actionKind: "trigger_n8n_workflow",
        inputSchema: triggerWorkflow,
        execute: async (ctx, args) => {
          const outcome = await this.client.notify({
            event: "workflow_trigger",
            workflow: String(args.workflow),
            payload: args.payload ?? {},
            taskId: ctx.taskId,
            step: ctx.step,
            at: new Date().toISOString(),
          });
          return outcome.ok ? { delivered: true, webhook: this.client.id } : { delivered: false, error: outcome.error };
        },
      },
    ];
  }
}