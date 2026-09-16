/**
 * E2E probe (dev script): boots the agent worker against Postgres in the same
 * process, inserts a real detect-issues task, and verifies the worker claims,
 * runs, persists the structured result, and files the issue — all through
 * PgRepository. Run: node --env-file-if-exists=.env scripts/probe-e2e.ts
 */
import { loadEnvFile, parseEnv, persistenceMode } from "../src/config/env.ts";
import { createLogger } from "../src/lib/logger.ts";
import { createPool } from "../src/db/pool.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PgRepository } from "../src/db/pgRepository.ts";
import { PermissionResolver } from "../src/domain/permissions.ts";
import { MockShopifyClient } from "../src/tools/shopify/mockClient.ts";
import { ShopifyToolProvider } from "../src/tools/shopify/provider.ts";
import { InternalToolProvider } from "../src/tools/internal/provider.ts";
import { BusinessToolProvider } from "../src/tools/business/provider.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { buildLlmGateway } from "../src/llm/factory.ts";
import { AgentTaskRunner } from "../src/agent/runner.ts";

loadEnvFile();
const env = parseEnv();
const logger = createLogger("info");
if (persistenceMode(env) !== "postgres" || !env.DATABASE_URL) {
  throw new Error("This probe requires PERSISTENCE=postgres and DATABASE_URL");
}

const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);
const repo = new PgRepository(pool);

const registry = new ToolRegistry(logger, new PermissionResolver())
  .register(new ShopifyToolProvider(new MockShopifyClient()))
  .register(new InternalToolProvider())
  .register(new BusinessToolProvider());
const gateway = buildLlmGateway(env, logger);
const runner = new AgentTaskRunner({ registry, gateway, repo, logger }, logger);

await runner.recoverRunning();
const task = await repo.createTask({
  type: "detect-issues",
  priority: "high",
  input: { orderId: "ord_1002", text: "Scheduled operations check: shipment shows no recent scan.", eventType: "scheduled_operations_check" },
});
logger.info({ taskId: task.id }, "probe: task inserted — worker will claim it");

const ran = await runner.drainPending();
logger.info({ ran }, "probe: worker drained");

const deadline = Date.now() + 20_000;
let done = false;
while (Date.now() < deadline && !done) {
  const t = await repo.getTask(task.id);
  if (t?.status === "succeeded" || t?.status === "failed") {
    done = true;
    const issues = await repo.listIssues({ status: "open" });
    console.log("E2E RESULT:", JSON.stringify({
      taskStatus: t.status,
      agentStatus: t.result?.status,
      requiresHumanApproval: t.result?.requiresHumanApproval,
      actions: t.result?.actions?.map((a) => `${a.tool}=${a.outcome}`),
      severityFindings: t.result?.findings?.map((f) => f.severity),
      openIssues: issues.map((i) => `${i.kind}:${i.title}`),
      persisted: !!t.result && !!t.completedAt,
    }, null, 2));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!done) {
  const t = await repo.getTask(task.id);
  console.log("E2E TIMEOUT", JSON.stringify(t));
}

await pool.end();
process.exit(done ? 0 : 1);