import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../lib/logger.ts";
import {
  LlmRequestError,
  type LlmGateway,
  type LlmRequest,
  type LlmResponse,
  type LlmToolSpec,
  type LlmToolUse,
  type LlmTurn,
} from "./gateway.ts";

/** Convert an LLM tool spec to what the Messages API expects. */
function toSdkMessages(transcript: LlmTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of transcript) {
    const blocks: Anthropic.ContentBlockParam[] = [];

    if (turn.role === "assistant") {
      if (turn.text) blocks.push({ type: "text", text: turn.text });
      for (const u of turn.toolUses ?? []) {
        blocks.push({ type: "tool_use", id: u.id, name: u.name, input: u.input });
      }
    } else {
      if (turn.text) blocks.push({ type: "text", text: turn.text });
      for (const r of turn.toolResults ?? []) {
        blocks.push({
          type: "tool_result",
          tool_use_id: r.id,
          content:
            typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2),
          is_error: r.isError,
        });
      }
    }

    if (blocks.length === 0 && turn.text) {
      messages.push({ role: turn.role, content: turn.text });
    } else {
      messages.push({ role: turn.role, content: blocks });
    }
  }
  return messages;
}

/** Convert the tools the model may propose into Messages-API tool definitions. */
function toSdkTools(tools: LlmToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => {
    // All our tool schemas describe JSON objects; strictness improves the model's
    // chance of emitting valid arguments on the first try.
    const schema = { ...(t.inputSchema as Record<string, unknown>), additionalProperties: false };
    return { name: t.name, description: t.description, input_schema: schema as unknown as Anthropic.Tool["input_schema"] };
  });
}

/**
 * Claude gateway: a single `messages.stream` turn (tool use → results is
 * orchestrated by the agent core). Requires ANTHROPIC_API_KEY (or an
 * `ant auth login` profile); the factory never constructs this without it.
 */
export class AnthropicLlmGateway implements LlmGateway {
  readonly id = "anthropic";

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly logger: Logger;

  constructor(logger: Logger, model: string) {
    this.logger = logger;
    this.model = model;
    this.client = new Anthropic();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.logger.debug({ model: this.model, turns: req.transcript.length, tools: req.tools.length }, "llm request");
    const stream = await this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      system: req.system,
      messages: toSdkMessages(req.transcript),
      tools: req.tools.length > 0 ? toSdkTools(req.tools) : undefined,
    });
    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const retryable = err.status !== undefined && (err.status === 429 || err.status >= 500);
        throw new LlmRequestError(`Anthropic API ${err.status}: ${err.message}`, retryable);
      }
      throw err;
    }

    if (response.stop_reason === "refusal" && response.stop_details) {
      throw new LlmRequestError(
        `Model declined: ${response.stop_details.category ?? "refusal"} — ${response.stop_details.explanation ?? ""}`,
      );
    }

    const text: string[] = [];
    const toolUses: LlmToolUse[] = [];
    for (const block of response.content) {
      if (block.type === "text") text.push(block.text);
      else if (block.type === "tool_use") {
        toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
      // thinking / redacted_thinking blocks are deliberately not echoed back.
    }

    this.logger.debug({ toolUses: toolUses.map((u) => u.name) }, "llm response");
    return { text: text.join("\n"), toolUses };
  }
}