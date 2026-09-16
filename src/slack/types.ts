/**
 * Slack transport layer — the operations channels of the business. Two
 * directions, both transport-swappable like email/n8n:
 *
 * - OUTBOUND (notifier): the agent posts an honest status/notification to a
 *   channel. `mock` records without network; `http` POSTs to an Incoming
 *   Webhook URL (a real Slack app/OAuth comes later — same interface swap).
 * - INBOUND (provider): messages arrive from any Slack source (a customer DM,
 *   an ops alert in #support) and are normalized into SlackMessage + polled,
 *   exactly like the email mailbox.
 */

// ── Inbound ──────────────────────────────────────────────────────────────────

export interface SlackMessage {
  /** Slack message id (a `ts`) — the dedup key. */
  id: string;
  /** Channel the message was posted in, e.g. "#support" or a DM id. */
  channel: string;
  /** Human label of the poster (display name / user id), when known. */
  user?: string;
  text: string;
  /** ISO timestamp Slack recorded. */
  receivedAt: string;
}

export interface SlackProvider {
  readonly id: string;
  /** Return messages received since the last poll. Never throws the first time. */
  poll(): Promise<SlackMessage[]>;
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export interface SlackPostResult {
  ok: boolean;
  channel?: string;
  /** Slack timestamp of the posted message, when the transport provides one. */
  ts?: string;
  error?: string;
}

export interface SlackNotifier {
  readonly id: "mock" | "http";
  /** Post a message to a channel. Never throws — failures are returned. */
  sendMessage(input: { channel: string; text: string }): Promise<SlackPostResult>;
}