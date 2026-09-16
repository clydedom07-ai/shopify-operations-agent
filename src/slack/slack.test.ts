import { describe, it, expect, afterEach } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { InMemoryRepository } from "../db/inMemoryRepository.ts";
import { PermissionResolver } from "../domain/permissions.ts";
import type { AgentEventType } from "../domain/types.ts";
import { ShopifyToolProvider } from "../tools/shopify/provider.ts";
import { MockShopifyClient } from "../tools/shopify/mockClient.ts";
import { InternalToolProvider } from "../tools/internal/provider.ts";
import { BusinessToolProvider } from "../tools/business/provider.ts";
import { SupplierToolProvider } from "../tools/supplier/provider.ts";
import { MockSupplierDirectory } from "../supplier/mockDirectory.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ScriptedLlmGateway } from "../llm/scriptedGateway.ts";
import { runAgentTask } from "../agent/core.ts";
import { createLogger } from "../lib/logger.ts";
import { ingestSlack } from "./ingestor.ts";
import { MockSlackNotifier } from "./mockNotifier.ts";
import { MockSlackProvider, defaultInbox } from "./mockProvider.ts";
import { HttpSlackNotifier } from "./httpNotifier.ts";
import { SlackToolProvider } from "../tools/slack/provider.ts";
import type { SlackMessage } from "./types.ts";

const logger = createLogger("silent");

function makeDeps(notifier?: MockSlackNotifier) {
  const repo = new InMemoryRepository();
  const registry = new ToolRegistry(logger, new PermissionResolver())
    .register(new ShopifyToolProvider(new MockShopifyClient()))
    .register(new SupplierToolProvider(new MockSupplierDirectory()))
    .register(new InternalToolProvider())
    .register(new BusinessToolProvider());
  if (notifier) registry.register(new SlackToolProvider(notifier, "#ops"));
  const gateway = new ScriptedLlmGateway(logger);
  return { repo, registry, gateway };
}

const openServers: Server[] = [];
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
});

function startServer(handler: http.RequestListener): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/services/x` });
    });
  });
}

describe("slack/mockSlackProvider", () => {
  it("drains the inbox once", async () => {
    const provider = new MockSlackProvider();
    const first = await provider.poll();
    const second = await provider.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.channel).toBe("#support");
    expect(second).toHaveLength(0);
  });
});

describe("slack/ingestor", () => {
  it("ingests a customer message as a task and records the event", async () => {
    const { repo } = makeDeps();
    const message: SlackMessage = {
      id: `sk_${randomUUID()}`,
      channel: "#support",
      user: "ava",
      text: "Hey, I ordered #1001 over a week ago and haven't heard anything.",
      receivedAt: new Date().toISOString(),
    };

    const result = await ingestSlack([message], repo, logger);
    expect(result.read).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.type).toBe("slack-message");

    const events = (await repo.listEvents({ type: "slack_message_received" as AgentEventType, limit: 10 })).filter(
      (e) => e.payload["messageId"] === message.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["channel"]).toBe("#support");
    expect(events[0]!.payload["user"]).toBe("ava");

    const task = (await repo.getTask(result.tasks[0]!.taskId))!;
    expect(task.type).toBe("slack-message");
    expect(task.input.metadata?.["channel"]).toBe("#support");
  });

  it("is idempotent: re-ingesting the same message id is skipped", async () => {
    const { repo } = makeDeps();
    const message: SlackMessage = {
      id: "sk_dup_1",
      channel: "#support",
      text: "dup",
      receivedAt: new Date().toISOString(),
    };

    const first = await ingestSlack([message], repo, logger);
    expect(first.tasks).toHaveLength(1);
    const second = await ingestSlack([message], repo, logger);
    expect(second.tasks).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });
});

describe("slack/agent flow", () => {
  it("runs a #1001 slack-message task and posts an honest ack on the channel", async () => {
    const notifier = new MockSlackNotifier();
    const { repo, registry, gateway } = makeDeps(notifier);
    const message = defaultInbox()[0]!;
    await ingestSlack([message], repo, logger);

    const task = (await repo.listTasks({ status: "pending" }))[0]!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 8 });

    expect(agentResult.status).toBe("resolved");
    // The slack_postMessage tool ran once, to the channel the customer used,
    // with the honest verdict summary — no invented tracking or dates.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.channel).toBe("#support");
    expect(notifier.sent[0]!.text).toContain("#1001");
    expect(agentResult.actions.some((a) => a.actionKind === "slack_post_message" && a.outcome === "performed")).toBe(true);
  });

  it("does NOT auto-post when the outcome needs human handling (delivered-not-received)", async () => {
    const notifier = new MockSlackNotifier();
    const { repo, registry, gateway } = makeDeps(notifier);
    const message: SlackMessage = {
      id: `sk_1003_${randomUUID()}`,
      channel: "#support",
      user: "marcus",
      text: "Tracking says #1003 was delivered to Austin but I never received it.",
      receivedAt: new Date().toISOString(),
    };
    await ingestSlack([message], repo, logger);

    const task = (await repo.listTasks({ status: "pending" }))[0]!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 8 });

    expect(agentResult.status).toBe("needs_approval");
    expect(agentResult.requiresHumanApproval).toBe(true);
    // Sensitive communication stays behind the human gate — nothing was posted.
    expect(notifier.sent).toHaveLength(0);
    expect(agentResult.actions.some((a) => a.actionKind === "slack_post_message")).toBe(false);
  });

  it("never proposes slack_postMessage when the tool is not registered (Slack off)", async () => {
    const { repo, registry, gateway } = makeDeps(); // no notifier
    await ingestSlack([defaultInbox()[0]!], repo, logger);

    const task = (await repo.listTasks({ status: "pending" }))[0]!;
    const agentResult = await runAgentTask(task, { registry, gateway, repo, logger, maxSteps: 6 });

    expect(agentResult.status).toBe("resolved");
    expect(agentResult.actions.some((a) => a.actionKind === "slack_post_message")).toBe(false);
  });
});

describe("slack/slackToolProvider", () => {
  it("posts the exact text and reports delivery", async () => {
    const notifier = new MockSlackNotifier();
    const provider = new SlackToolProvider(notifier, "#ops");
    const def = provider.listTools()[0]!;
    const ctx = { taskId: "t-1", step: 3 } as never;

    const out = await def.execute(ctx, { channel: "#support", text: "Order #1001 is on schedule." });
    expect(out).toMatchObject({ delivered: true, channel: "#support", notifier: "mock" });
    expect(notifier.sent).toEqual([{ channel: "#support", text: "Order #1001 is on schedule." }]);
  });

  it("falls back to the configured default channel and surfaces a failure", async () => {
    const notifier = new MockSlackNotifier(true);
    const provider = new SlackToolProvider(notifier, "#ops");
    const def = provider.listTools()[0]!;
    const ctx = { taskId: "t-1", step: 3 } as never;

    const out = (await def.execute(ctx, { text: "hello" })) as { delivered: boolean; error: string };
    expect(out.delivered).toBe(false);
    expect(out.error).toBeTruthy();
    expect(notifier.sent).toHaveLength(1);
  });
});

describe("slack/mockNotifier", () => {
  it("records sends and reports a timestamp", async () => {
    const notifier = new MockSlackNotifier();
    const out = await notifier.sendMessage({ channel: "#support", text: "hi" });
    expect(out.ok).toBe(true);
    expect(out.ts).toBeTruthy();
    expect(notifier.sent).toHaveLength(1);
  });

  it("surfaces a forced failure", async () => {
    const out = await new MockSlackNotifier(true).sendMessage({ channel: "#support", text: "hi" });
    expect(out.ok).toBe(false);
  });
});

describe("slack/httpNotifier", () => {
  it("POSTs a JSON message and reports success", async () => {
    let received: { body?: unknown; type?: string } = {};
    const { url } = await startServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received = { body: JSON.parse(data), type: req.headers["content-type"] };
        res.writeHead(200);
        res.end("ok");
      });
    });

    const out = await new HttpSlackNotifier(url).sendMessage({ channel: "#support", text: "hi" });
    expect(out.ok).toBe(true);
    expect(received.type).toContain("application/json");
    expect(received.body).toMatchObject({ channel: "#support", text: "hi" });
  });

  it("reports a non-2xx webhook response as a failure", async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(400);
      res.end("invalid_payload");
    });

    const out = await new HttpSlackNotifier(url).sendMessage({ channel: "#support", text: "hi" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("400");
  });

  it("aborts a hanging webhook after the timeout", async () => {
    const { url } = await startServer((_req, _res) => {
      /* intentionally never respond */
    });

    const started = Date.now();
    const out = await new HttpSlackNotifier(url, 50).sendMessage({ channel: "#support", text: "hi" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});