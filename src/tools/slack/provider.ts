import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";
import type { SlackNotifier } from "../../slack/types.ts";

const slackPostMessage = z.object({
  /** Channel to post to — the metadata channel on ingress, or the default below. */
  channel: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(4000),
});

/**
 * Lets the agent post an honest message to a Slack channel (the ops/support
 * wire of the business). Auto-tier, like the other routine internal sends — an
 * outgoing message is exactly what was executed, and the notifier is
 * injectable, so the mock records without network and the real client POSTs to
 * the webhook URL. Customer-significant communications stay approval-gated via
 * `send_customer_email`; this tool carries only the honest routine updates the
 * agent is deterministic-policy-authorized to send.
 */
export class SlackToolProvider implements ToolProvider {
  readonly id = "slack";
  readonly label = "Slack";

  private readonly notifier: SlackNotifier;
  private readonly defaultChannel: string;

  constructor(notifier: SlackNotifier, defaultChannel = "#ops") {
    this.notifier = notifier;
    this.defaultChannel = defaultChannel;
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: "slack_postMessage",
        description:
          "Post a message to a Slack channel (e.g. an honest status reply to the support channel a customer messaged). The message text is sent verbatim.",
        actionKind: "slack_post_message",
        inputSchema: slackPostMessage,
        execute: async (_ctx, args) => {
          const channel = String(args.channel ?? this.defaultChannel);
          const outcome = await this.notifier.sendMessage({ channel, text: String(args.text) });
          return outcome.ok
            ? { delivered: true, channel, notifier: this.notifier.id, ts: outcome.ts ?? null }
            : { delivered: false, channel, error: outcome.error };
        },
      },
    ];
  }
}