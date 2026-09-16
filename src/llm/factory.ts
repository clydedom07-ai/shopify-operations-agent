import type { Env } from "../config/env.ts";
import type { Logger } from "../lib/logger.ts";
import { AnthropicLlmGateway } from "./anthropicGateway.ts";
import { ScriptedLlmGateway } from "./scriptedGateway.ts";
import type { LlmGateway } from "./gateway.ts";

/**
 * Pick the LLM backend: Claude when a key is present, otherwise the
 * deterministic scripted gateway (zero credentials — full loop still works).
 * The scripted gateway is a required fallback, not a downgrade path for tests
 * only: it keeps the service honest when the LLM is unreachable or unconfigured.
 */
export function buildLlmGateway(env: Pick<Env, "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL">, logger: Logger): LlmGateway {
  if (env.ANTHROPIC_API_KEY) {
    logger.info({ model: env.ANTHROPIC_MODEL }, "llm backend: anthropic");
    return new AnthropicLlmGateway(logger, env.ANTHROPIC_MODEL);
  }
  logger.info(
    "llm backend: scripted (no ANTHROPIC_API_KEY) — deterministic investigation SOP, no external calls",
  );
  return new ScriptedLlmGateway(logger);
}