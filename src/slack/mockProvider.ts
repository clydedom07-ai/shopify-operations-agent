import type { SlackProvider, SlackMessage } from "./types.ts";

/**
 * Deterministic, network-free inbound Slack for dev/tests: a single inbox that
 * drains once, mirroring the mock email mailbox. The one message is a customer
 * "where is my order?" inside #support — it flows through the same event→task
 * pipeline as an email, and the agent replies on the channel.
 */
export class MockSlackProvider implements SlackProvider {
  readonly id = "mock";

  private readonly pending: SlackMessage[];
  private drained = false;

  constructor(messages: SlackMessage[] = defaultInbox()) {
    this.pending = messages;
  }

  async poll(): Promise<SlackMessage[]> {
    if (this.drained) return [];
    this.drained = true;
    return this.pending;
  }
}

/** Reusable scripted inbox (customer message in #support about order #1001). */
export function defaultInbox(): SlackMessage[] {
  return [
    {
      id: "sk_1001_1",
      channel: "#support",
      user: "ava",
      text: "Hey, I ordered #1001 over a week ago and haven't heard anything.",
      receivedAt: new Date().toISOString(),
    },
  ];
}