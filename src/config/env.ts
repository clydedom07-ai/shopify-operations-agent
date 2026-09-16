import { z } from "zod";
import { config as loadDotenv } from "dotenv";

/**
 * Project env wins over ambient shell vars. Critical on machines that export a
 * global DATABASE_URL for some OTHER project (e.g. autoflow) — without this, a
 * stray URL could point our migrations at the wrong database. Node's native
 * --env-file does NOT override existing vars, so we load with override:true.
 */
export function loadEnvFile(): void {
  loadDotenv({ override: true });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  API_AUTH_TOKEN: z.string().min(1).default("local-dev-token"),
  // SAFE DEFAULT: never write anywhere unless the project opts into Postgres.
  PERSISTENCE: z.enum(["auto", "memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().optional(),
  // LLM. No key → the deterministic scripted gateway runs (zero credentials,
  // hermetic). With ANTHROPIC_API_KEY the real Claude gateway is used.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  // Email intake. OFF by default — a real mailbox integration does not exist
  // yet, so nothing polls unless the project explicitly opts into the mock.
  EMAIL_INGESTION: z.enum(["off", "mock"]).default("off"),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  // n8n callback. OFF by default: the agent POSTs a task_completed payload to
  // an n8n Webhook trigger when a task succeeds. `mock` records without
  // network (hermetic/dev); `http` requires N8N_WEBHOOK_URL.
  N8N_CALLBACK: z.enum(["off", "mock", "http"]).default("off"),
  N8N_WEBHOOK_URL: z.string().optional(),
  // Slack. OFF by default on both sides. Outbound (`SLACK_NOTIFY`): the agent
  // posts honest routine updates to `SLACK_CHANNEL`; `mock` records without
  // network, `http` POSTs to SLACK_WEBHOOK_URL (Incoming Webhook). Inbound
  // (`SLACK_INGESTION`): polls messages through the same event→task pipeline
  // as email; only the mock provider exists today.
  SLACK_NOTIFY: z.enum(["off", "mock", "http"]).default("off"),
  SLACK_WEBHOOK_URL: z.string().optional(),
  SLACK_CHANNEL: z.string().min(1).max(120).default("#ops"),
  SLACK_INGESTION: z.enum(["off", "mock"]).default("off"),
  SLACK_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  // Shopify. CORE backend, so it defaults to the deterministic mock (the agent
  // runs with zero credentials). `http` talks to a store's Admin API and
  // requires the store + access token; SHOPIFY_API_VERSION defaults to a
  // documented stable release, but operators should pin the current one.
  SHOPIFY_MODE: z.enum(["off", "mock", "http"]).default("mock"),
  SHOPIFY_STORE: z.string().optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().optional(),
  // Generic outbound REST. OFF by default: the agent may reach ONE
  // operator-configured base origin (`REST_BASE_URL`), read via the auto-tier
  // `rest_get` tool and write via the approval-tier `rest_write`. `mock`
  // answers from a route table without network (hermetic/dev); `http` requires
  // REST_BASE_URL and sets the guard.
  REST_MODE: z.enum(["off", "mock", "http"]).default("off"),
  REST_BASE_URL: z.string().optional(),
  // HTTP API hardening. Rate limit is per client IP (in-memory sliding window,
  // single process). API_TRUST_PROXY must only be "true" when the server sits
  // behind a reverse proxy that forwards X-Forwarded-For — with it false, the
  // limiter keys on the direct socket address, which is the safe default.
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  API_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});
export type Env = z.infer<typeof envSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(env);
  if (parsed.N8N_CALLBACK === "http" && !parsed.N8N_WEBHOOK_URL) {
    throw new Error("N8N_CALLBACK=http requires N8N_WEBHOOK_URL");
  }
  if (parsed.SLACK_NOTIFY === "http" && !parsed.SLACK_WEBHOOK_URL) {
    throw new Error("SLACK_NOTIFY=http requires SLACK_WEBHOOK_URL");
  }
  if (parsed.REST_MODE === "http" && !parsed.REST_BASE_URL) {
    throw new Error("REST_MODE=http requires REST_BASE_URL");
  }
  if (parsed.SHOPIFY_MODE === "http" && (!parsed.SHOPIFY_STORE || !parsed.SHOPIFY_ACCESS_TOKEN)) {
    throw new Error("SHOPIFY_MODE=http requires SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN");
  }
  return parsed;
}

export type PersistenceMode = "memory" | "postgres";

/**
 * Postgres is opt-in. `postgres` (or `auto` with DATABASE_URL set) uses the
 * project's DATABASE_URL; anything else runs on the in-memory repository, so a
 * stray ambient DATABASE_URL can never capture the agent silently.
 */
export function persistenceMode(env: Env): PersistenceMode {
  if (env.PERSISTENCE === "postgres") return "postgres";
  if (env.PERSISTENCE === "auto") return env.DATABASE_URL ? "postgres" : "memory";
  return "memory";
}