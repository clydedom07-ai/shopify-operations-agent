import type { SlackNotifier, SlackPostResult } from "./types.ts";

/**
 * Deterministic, network-free Slack notifier for dev and tests: records every
 * message it is asked to send. `failNext` forces a failure so the tool's error
 * path is exercisable without a server.
 */
export class MockSlackNotifier implements SlackNotifier {
  readonly id = "mock";
  readonly sent: Array<{ channel: string; text: string }> = [];
  private readonly failNext: boolean;

  constructor(failNext = false) {
    this.failNext = failNext;
  }

  async sendMessage(input: { channel: string; text: string }): Promise<SlackPostResult> {
    this.sent.push(input);
    if (this.failNext) return { ok: false, error: "mock slack failure" };
    return { ok: true, channel: input.channel, ts: `sk-sent-${this.sent.length}` };
  }
}