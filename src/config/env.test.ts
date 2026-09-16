import { describe, expect, it } from "vitest";
import { parseEnv, persistenceMode } from "./env.ts";

describe("config/env", () => {
  it("applies defaults", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.API_AUTH_TOKEN).toBe("local-dev-token");
    expect(env.PERSISTENCE).toBe("memory");
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-5");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.EMAIL_INGESTION).toBe("off");
    expect(env.EMAIL_POLL_INTERVAL_MS).toBe(60_000);
    expect(env.N8N_CALLBACK).toBe("off");
    expect(env.N8N_WEBHOOK_URL).toBeUndefined();
    expect(env.SLACK_NOTIFY).toBe("off");
    expect(env.SLACK_WEBHOOK_URL).toBeUndefined();
    expect(env.SLACK_CHANNEL).toBe("#ops");
    expect(env.SLACK_INGESTION).toBe("off");
    expect(env.SLACK_POLL_INTERVAL_MS).toBe(60_000);
    expect(env.REST_MODE).toBe("off");
    expect(env.REST_BASE_URL).toBeUndefined();
    expect(env.SHOPIFY_MODE).toBe("mock");
    expect(env.SHOPIFY_STORE).toBeUndefined();
    expect(env.SHOPIFY_ACCESS_TOKEN).toBeUndefined();
    expect(env.SHOPIFY_API_VERSION).toBeUndefined();
    expect(env.API_RATE_LIMIT_MAX).toBe(120);
    expect(env.API_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.API_TRUST_PROXY).toBe("false");
  });

  it("accepts n8n callback modes and validates the http mode", () => {
    expect(parseEnv({ N8N_CALLBACK: "mock" }).N8N_CALLBACK).toBe("mock");
    expect(parseEnv({ N8N_CALLBACK: "http", N8N_WEBHOOK_URL: "https://n8n.example.com/webhook/abc" }).N8N_WEBHOOK_URL).toBe(
      "https://n8n.example.com/webhook/abc",
    );
    // http without a webhook URL is a misconfiguration, not a silent no-op.
    expect(() => parseEnv({ N8N_CALLBACK: "http" })).toThrow(/N8N_WEBHOOK_URL/);
    expect(() => parseEnv({ N8N_CALLBACK: "slack" })).toThrow();
  });

  it("parses the Slack opt-ins and validates the http notifier", () => {
    expect(parseEnv({ SLACK_INGESTION: "mock" }).SLACK_INGESTION).toBe("mock");
    expect(parseEnv({ SLACK_INGESTION: "mock", SLACK_POLL_INTERVAL_MS: "1500" }).SLACK_POLL_INTERVAL_MS).toBe(1500);
    expect(parseEnv({ SLACK_NOTIFY: "mock" }).SLACK_NOTIFY).toBe("mock");
    expect(parseEnv({ SLACK_NOTIFY: "http", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x" }).SLACK_WEBHOOK_URL).toBe(
      "https://hooks.slack.com/services/x",
    );
    expect(parseEnv({ SLACK_CHANNEL: "#support" }).SLACK_CHANNEL).toBe("#support");
    // http without a webhook URL is a misconfiguration, not a silent no-op.
    expect(() => parseEnv({ SLACK_NOTIFY: "http" })).toThrow(/SLACK_WEBHOOK_URL/);
    expect(() => parseEnv({ SLACK_INGESTION: "poll" })).toThrow();
    expect(() => parseEnv({ SLACK_NOTIFY: "email" })).toThrow();
  });

  it("parses the generic REST opt-in and validates the http mode", () => {
    expect(parseEnv({ REST_MODE: "mock" }).REST_MODE).toBe("mock");
    expect(parseEnv({ REST_MODE: "http", REST_BASE_URL: "https://ops.internal.example.com" }).REST_BASE_URL).toBe(
      "https://ops.internal.example.com",
    );
    // http without a base URL is a misconfiguration, not a silent no-op.
    expect(() => parseEnv({ REST_MODE: "http" })).toThrow(/REST_BASE_URL/);
    expect(() => parseEnv({ REST_MODE: "slack" })).toThrow();
  });

  it("parses the Shopify backend and validates the http mode", () => {
    // OFF and mock are silent no-credentials modes.
    expect(parseEnv({ SHOPIFY_MODE: "off" }).SHOPIFY_MODE).toBe("off");
    expect(parseEnv({ SHOPIFY_MODE: "mock", SHOPIFY_STORE: "x.myshopify.com" }).SHOPIFY_MODE).toBe("mock");
    // http requires both the store and the access token — either alone is a
    // misconfiguration, not a silent fallback to the mock.
    expect(
      parseEnv({
        SHOPIFY_MODE: "http",
        SHOPIFY_STORE: "your-store.myshopify.com",
        SHOPIFY_ACCESS_TOKEN: "shpat_abc",
        SHOPIFY_API_VERSION: "2024-10",
      }).SHOPIFY_API_VERSION,
    ).toBe("2024-10");
    expect(() => parseEnv({ SHOPIFY_MODE: "http" })).toThrow(/SHOPIFY_STORE/);
    expect(() => parseEnv({ SHOPIFY_MODE: "http", SHOPIFY_STORE: "x.myshopify.com" })).toThrow(/SHOPIFY_ACCESS_TOKEN/);
    expect(() => parseEnv({ SHOPIFY_MODE: "carrier" })).toThrow();
  });

  it("accepts an ANTHROPIC_API_KEY and passes the model through", () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_MODEL: "claude-opus-5" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_MODEL).toBe("claude-opus-5");
  });

  it("parses the mock email ingestion opt-in", () => {
    expect(parseEnv({ EMAIL_INGESTION: "mock" }).EMAIL_INGESTION).toBe("mock");
    expect(parseEnv({ EMAIL_INGESTION: "mock", EMAIL_POLL_INTERVAL_MS: "1500" }).EMAIL_POLL_INTERVAL_MS).toBe(1500);
    expect(() => parseEnv({ EMAIL_INGESTION: "gmail" })).toThrow();
  });

  it("coerces PORT from string env", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects invalid PERSISTENCE values", () => {
    expect(() => parseEnv({ PERSISTENCE: "elsewhere" })).toThrow();
  });

  it("ignores an ambient DATABASE_URL unless Postgres is opted into", () => {
    // e.g. a shell exporting DATABASE_URL for another project must not capture us.
    const env = parseEnv({ DATABASE_URL: "postgres://autoflow@localhost:5432/autoflow" });
    expect(env.PERSISTENCE).toBe("memory");
    expect(persistenceMode(env)).toBe("memory");
  });

  it("resolves memory when no DATABASE_URL on auto", () => {
    expect(persistenceMode(parseEnv({ PERSISTENCE: "auto", DATABASE_URL: undefined }))).toBe("memory");
  });

  it("resolves postgres when DATABASE_URL is set on auto", () => {
    expect(persistenceMode(parseEnv({ PERSISTENCE: "auto", DATABASE_URL: "postgres://u:p@h/db" }))).toBe("postgres");
  });

  it("allows forcing memory or postgres explicitly", () => {
    expect(persistenceMode(parseEnv({ PERSISTENCE: "memory", DATABASE_URL: "postgres://u:p@h/db" }))).toBe("memory");
    expect(persistenceMode(parseEnv({ PERSISTENCE: "postgres" }))).toBe("postgres");
  });

  it("parses the API hardening knobs and rejects a sloppy trust flag", () => {
    const env = parseEnv({ API_RATE_LIMIT_MAX: "50", API_RATE_LIMIT_WINDOW_MS: "5000", API_TRUST_PROXY: "true" });
    expect(env.API_RATE_LIMIT_MAX).toBe(50);
    expect(env.API_RATE_LIMIT_WINDOW_MS).toBe(5_000);
    expect(env.API_TRUST_PROXY).toBe("true");
    // A non-boolean trust flag is a misconfiguration, not a silent guess.
    expect(() => parseEnv({ API_TRUST_PROXY: "yes" })).toThrow();
  });
});