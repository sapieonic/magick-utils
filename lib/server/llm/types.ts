// Provider-agnostic LLM contracts. Server-only — no React, no vendor lock-in.
// Adapters (openai-compatible, anthropic) implement `LLMProvider`; the factory
// in ./index.ts picks one based on env config.

import type { ZodType } from "zod";

/** A single chat message. Mirrors the lowest common denominator across vendors. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Per-call tuning knobs. All optional — adapters supply sane defaults. */
export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  /** Override the provider's default model for this single call. */
  model?: string;
}

/**
 * The contract every adapter satisfies. Callers depend on this, never on a
 * concrete vendor SDK.
 */
export interface LLMProvider {
  /** One-shot completion → the assistant's text. */
  complete(messages: ChatMessage[], opts?: LLMOptions): Promise<string>;

  /** Streaming completion → async iterable of text deltas. */
  stream(messages: ChatMessage[], opts?: LLMOptions): AsyncIterable<string>;

  /**
   * Completion constrained to a zod schema. Validates the model output against
   * `schema`, retrying once with an error-correcting follow-up before throwing.
   */
  structured<T>(
    messages: ChatMessage[],
    schema: ZodType<T>,
    opts?: LLMOptions,
  ): Promise<T>;

  /** The default model this provider was constructed with. */
  readonly model: string;
}
