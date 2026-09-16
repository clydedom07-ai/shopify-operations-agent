import type { SlackNotifier, SlackPostResult } from "./types.ts";

/**
 * Real Slack notifier: POSTs to an Incoming Webhook URL (the webhook is
 * channel-bound, so `channel` is informational; Slack uses the webhook's own
 * channel). Short timeout so a slow Slack can't stall the agent loop; failures
 * are returned, never thrown. A real Slack app/Web API comes later behind the
 * same interface.
 */
export class HttpSlackNotifier implements SlackNotifier {
  readonly id = "http";
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(webhookUrl: string, timeoutMs = 5_000) {
    this.webhookUrl = webhookUrl;
    this.timeoutMs = timeoutMs;
  }

  async sendMessage(input: { channel: string; text: string }): Promise<SlackPostResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: input.channel, text: input.text }),
        signal: controller.signal,
      });
      return res.ok
        ? { ok: true, channel: input.channel, ts: undefined }
        : { ok: false, error: `slack webhook returned HTTP ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `slack webhook call failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}