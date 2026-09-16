import type { N8nNotifyResult, N8nWebhookClient } from "./types.ts";

/**
 * Deterministic, network-free n8n client for dev and tests: records every
 * callback it is asked to send. `failNext` forces a failure so the runner's
 * error path is exercisable without a server.
 */
export class MockN8nWebhookClient implements N8nWebhookClient {
  readonly id = "mock";
  readonly sent: Record<string, unknown>[] = [];
  private readonly failNext: boolean;

  constructor(failNext = false) {
    this.failNext = failNext;
  }

  async notify(payload: Record<string, unknown>): Promise<N8nNotifyResult> {
    this.sent.push(payload);
    if (this.failNext) return { ok: false, error: "mock webhook failure" };
    return { ok: true, status: 200 };
  }
}