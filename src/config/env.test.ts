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
});