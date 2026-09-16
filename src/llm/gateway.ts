/**
 * LLM gateway boundary.
 *
 * The agent core drives an investigation loop and speaks ONLY through this
 * interface. That keeps the loop deterministic and testable: the scripted
 * gateway (no credentials) and the Claude gateway implement the same contract,
 * and the loop enforces permissions regardless of which one answers.
 *
 * Name discipline: the model PROPOSES tool uses; the permission layer decides
 * whether they run. The model is never an authorization input.
 */

/** A tool use the model proposed and is asking the harness to execute. */
export interface LlmToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The outcome/result of one executed tool use, fed back to the model. */
export interface LlmToolResult {
  id: string;
  name: string;
  /** Anything serializable: tool output, or an error message. */
  result: unknown;
  isError: boolean;
}

/**
 * One conversational turn. Text, proposed tool uses, and tool results may
 * coexist; the Anthropic gateway maps this to Messages-API content blocks and
 * the scripted gateway reads it back.
 */
export interface LlmTurn {
  role: "user" | "assistant";
  text?: string;
  toolUses?: LlmToolUse[];
  toolResults?: LlmToolResult[];
}

/** The tool contract the model sees — JSON Schema, so /v1/messages accepts it. */
export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  transcript: LlmTurn[];
  tools: LlmToolSpec[];
}

export interface LlmResponse {
  /** Prose (echoed in summary / future customer text). Never treated as fact. */
  text: string;
  /** Tool uses proposed this turn — the harness decides which may run. */
  toolUses: LlmToolUse[];
}

/** Distinguishes retryable transport/limit failures from permanent ones. */
export class LlmRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "LlmRequestError";
    this.retryable = retryable;
  }
}

export interface LlmGateway {
  readonly id: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}