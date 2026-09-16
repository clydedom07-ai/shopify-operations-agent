import type { N8nNotifyResult, N8nWebhookClient } from "./types.ts";

/**
 * Real n8n webhook client: POSTs the callback payload to a configured Webhook
 * trigger URL. Short timeout so a slow or downed workflow cannot stall the
 * agent loop; failures are surfaced as a result, not thrown.
 */
export class HttpN8nWebhookClient implements N8nWebhookClient {
  readonly id = "http";
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(webhookUrl: string, timeoutMs = 5_000) {
    this.webhookUrl = webhookUrl;
    this.timeoutMs = timeoutMs;
  }

  async notify(payload: Record<string, unknown>): Promise<N8nNotifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `n8n webhook returned HTTP ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `n8n webhook call failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}