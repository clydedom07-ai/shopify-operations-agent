import type { Logger } from "../lib/logger.ts";
import type { Repository } from "../domain/repository.ts";
import type { SlackMessage } from "./types.ts";

export interface SlackIngestResult {
  read: number;
  skipped: number;
  tasks: Array<{ taskId: string; type: string; messageId: string }>;
}

/**
 * Turn inbound Slack messages into the same event→task pipeline the API and
 * email use: each message is recorded as a `slack_message_received` event,
 * then a `slack-message` task is queued for the agent. Re-ingestion is avoided
 * by checking the event log for the message id (Slack `ts`), so the mock inbox
 * draining (or a restart) never double-processes a message.
 */
export async function ingestSlack(
  messages: SlackMessage[],
  repo: Repository,
  logger: Logger,
): Promise<SlackIngestResult> {
  const result: SlackIngestResult = { read: messages.length, skipped: 0, tasks: [] };

  for (const message of messages) {
    const seen = (await repo.listEvents({ limit: 500 })).some(
      (e) => e.type === "slack_message_received" && e.payload["messageId"] === message.id,
    );
    if (seen) {
      result.skipped += 1;
      continue;
    }

    await repo.recordEvent({
      type: "slack_message_received",
      payload: {
        messageId: message.id,
        channel: message.channel,
        user: message.user ?? null,
        receivedAt: message.receivedAt,
      },
      source: "slack",
    });
    const task = await repo.createTask({
      type: "slack-message",
      priority: "high",
      input: {
        text: message.text,
        eventType: "slack_message_received",
        metadata: { messageId: message.id, channel: message.channel, user: message.user ?? null, receivedAt: message.receivedAt },
      },
    });
    result.tasks.push({ taskId: task.id, type: task.type, messageId: message.id });
    logger.info({ messageId: message.id, taskId: task.id, channel: message.channel }, "ingested slack message");
  }

  return result;
}