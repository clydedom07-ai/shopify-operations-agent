import { loadEnvFile, parseEnv, persistenceMode } from "./config/env.ts";
import { createLogger } from "./lib/logger.ts";
import { createPool } from "./db/pool.ts";
import { runMigrations } from "./db/migrate.ts";
import { InMemoryRepository } from "./db/inMemoryRepository.ts";
import { PgRepository } from "./db/pgRepository.ts";
import { PermissionResolver } from "./domain/permissions.ts";
import { MockShopifyClient } from "./tools/shopify/mockClient.ts";
import { ShopifyToolProvider } from "./tools/shopify/provider.ts";
import { InternalToolProvider } from "./tools/internal/provider.ts";
import { BusinessToolProvider } from "./tools/business/provider.ts";
import { SupplierToolProvider } from "./tools/supplier/provider.ts";
import { MockSupplierDirectory } from "./supplier/mockDirectory.ts";
import { N8nToolProvider } from "./tools/n8n/provider.ts";
import { HttpN8nWebhookClient } from "./n8n/httpClient.ts";
import { MockN8nWebhookClient } from "./n8n/mockClient.ts";
import { n8nCallbackTaskCompletion } from "./n8n/callback.ts";
import type { N8nWebhookClient } from "./n8n/types.ts";
import { MockEmailProvider } from "./email/mockProvider.ts";
import { ingestInbound } from "./email/ingestor.ts";
import { SlackToolProvider } from "./tools/slack/provider.ts";
import { HttpSlackNotifier } from "./slack/httpNotifier.ts";
import { MockSlackNotifier } from "./slack/mockNotifier.ts";
import { MockSlackProvider } from "./slack/mockProvider.ts";
import { ingestSlack } from "./slack/ingestor.ts";
import type { SlackNotifier } from "./slack/types.ts";
import { MockRestClient } from "./rest/mockClient.ts";
import { HttpRestClient } from "./rest/httpClient.ts";
import { RestToolProvider } from "./tools/rest/provider.ts";
import type { RestClient } from "./rest/types.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { buildLlmGateway } from "./llm/factory.ts";
import { AgentTaskRunner } from "./agent/runner.ts";
import { buildApiServer } from "./api/server.ts";

loadEnvFile();
const env = parseEnv();
const logger = createLogger(env.LOG_LEVEL);
const persistence = persistenceMode(env);

const pool = persistence === "postgres" && env.DATABASE_URL ? createPool(env.DATABASE_URL) : null;
if (pool) await runMigrations(pool);
const repo = pool ? new PgRepository(pool) : new InMemoryRepository();

// n8n: OFF → no callback at all; mock → records without network (dev/tests);
// http → POSTs a task_completed payload to the n8n Webhook URL after each task.
const n8nClient: N8nWebhookClient | null =
  env.N8N_CALLBACK === "http" && env.N8N_WEBHOOK_URL
    ? new HttpN8nWebhookClient(env.N8N_WEBHOOK_URL)
    : env.N8N_CALLBACK === "mock"
      ? new MockN8nWebhookClient()
      : null;

// Slack outbound: OFF → no posts at all; mock → records without network; http →
// POSTs to an Incoming Webhook URL. The tool registers only when a notifier
// exists, so a Slack-less deployment never even sees the tool.
const slackNotifier: SlackNotifier | null =
  env.SLACK_NOTIFY === "http" && env.SLACK_WEBHOOK_URL
    ? new HttpSlackNotifier(env.SLACK_WEBHOOK_URL)
    : env.SLACK_NOTIFY === "mock"
      ? new MockSlackNotifier()
      : null;

// Generic outbound REST: OFF → no REST tools; mock → route table without
// network; http → fetch against REST_BASE_URL with a 5s timeout and origin
// guard. The client holds the base origin, so the agent can never reach
// arbitrary hosts — it is exactly what the deployment authorized.
const restClient: RestClient | null =
  env.REST_MODE === "http" && env.REST_BASE_URL
    ? new HttpRestClient(env.REST_BASE_URL)
    : env.REST_MODE === "mock"
      ? new MockRestClient()
      : null;

const registry = new ToolRegistry(logger, new PermissionResolver())
  .register(new ShopifyToolProvider(new MockShopifyClient()))
  .register(new SupplierToolProvider(new MockSupplierDirectory()))
  .register(new InternalToolProvider())
  .register(new BusinessToolProvider());
if (n8nClient) registry.register(new N8nToolProvider(n8nClient));
if (slackNotifier) registry.register(new SlackToolProvider(slackNotifier, env.SLACK_CHANNEL));
if (restClient) registry.register(new RestToolProvider(restClient));

// Anthropic when ANTHROPIC_API_KEY is set; otherwise the deterministic
// scripted SOP gateway — the agent loop is identical either way.
const gateway = buildLlmGateway(env, logger);
const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger, {
  onTaskComplete:
    n8nClient === null
      ? undefined
      : async (task, result) => {
          await n8nCallbackTaskCompletion(task, result, { client: n8nClient, logger });
        },
});

// Reclaim tasks a previous process died on, so work survives restarts.
await runner.recoverRunning();

// Email intake is opt-in. A real mailbox integration does not exist yet, so
// nothing polls unless EMAIL_INGESTION=mock. The poller only turns emails into
// events + tasks; the runner (already claiming) does the actual work.
let emailTimer: ReturnType<typeof setInterval> | null = null;
if (env.EMAIL_INGESTION === "mock") {
  const emailProvider = new MockEmailProvider();
  const tick = async (): Promise<void> => {
    try {
      const emails = await emailProvider.poll();
      if (emails.length === 0) return;
      const result = await ingestInbound(emails, repo, logger);
      logger.info(
        { read: result.read, queued: result.tasks.length, skipped: result.skipped },
        "email ingestion tick",
      );
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "email ingestion tick failed");
    }
  };
  logger.info(
    { provider: emailProvider.id, intervalMs: env.EMAIL_POLL_INTERVAL_MS },
    "email ingestion enabled",
  );
  void tick();
  emailTimer = setInterval(() => void tick(), env.EMAIL_POLL_INTERVAL_MS);
}

// Slack inbound is opt-in, same pattern as email — only the mock provider
// exists today; messages enter the same events + tasks pipeline.
let slackTimer: ReturnType<typeof setInterval> | null = null;
if (env.SLACK_INGESTION === "mock") {
  const slackProvider = new MockSlackProvider();
  const tick = async (): Promise<void> => {
    try {
      const messages = await slackProvider.poll();
      if (messages.length === 0) return;
      const result = await ingestSlack(messages, repo, logger);
      logger.info(
        { read: result.read, queued: result.tasks.length, skipped: result.skipped },
        "slack ingestion tick",
      );
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "slack ingestion tick failed");
    }
  };
  logger.info(
    { provider: slackProvider.id, intervalMs: env.SLACK_POLL_INTERVAL_MS },
    "slack ingestion enabled",
  );
  void tick();
  slackTimer = setInterval(() => void tick(), env.SLACK_POLL_INTERVAL_MS);
}

const app = buildApiServer({ repo, registry, logger, apiAuthToken: env.API_AUTH_TOKEN, persistence });
const pendingTasks = await repo.listTasks({ status: "pending" });
logger.info(
  {
    persistence,
    port: env.PORT,
    tools: registry.names().length,
    pendingTasks: pendingTasks.length,
    llm: gateway.id,
    emailIngestion: env.EMAIL_INGESTION,
    slackNotify: env.SLACK_NOTIFY,
    slackIngestion: env.SLACK_INGESTION,
    n8nCallback: env.N8N_CALLBACK,
    rest: env.REST_MODE,
  },
  "Shopify Operations Agent booted",
);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "shutting down");
  if (emailTimer) clearInterval(emailTimer);
  if (slackTimer) clearInterval(slackTimer);
  runner.stop();
  await app.close();
  if (pool) await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
logger.info({ host: env.HOST, port: env.PORT }, "http api listening");
await runner.start();