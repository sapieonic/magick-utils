// Anthropic adapter. Implements the same provider contract using the Messages
// API. Selected when env.llm.provider === "anthropic". Relies only on portable
// features (messages + tool use) so it stays comparable to the OpenAI-compatible
// adapter — no Anthropic-only surface beyond forced tool use.

import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";

import {
  structuredRetryInstruction,
  structuredSystemInstruction,
  toJsonSchema,
  tryParse,
} from "./json";
import type { ChatMessage, LLMOptions, LLMProvider } from "./types";

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

const DEFAULT_MAX_TOKENS = 4096;
const STRUCTURED_TOOL_NAME = "emit_result";

/**
 * Split a leading run of `system` messages out into the Anthropic `system`
 * param and return the remaining user/assistant turns. Anthropic does not
 * accept `system` inside the messages array.
 */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  rest: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    systemParts.push(messages[i].content);
    i += 1;
  }
  // Fold any later stray system messages into user turns so nothing is dropped.
  const rest: Anthropic.MessageParam[] = [];
  for (; i < messages.length; i += 1) {
    const m = messages[i];
    const role = m.role === "assistant" ? "assistant" : "user";
    rest.push({ role, content: m.content });
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest,
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text")
    .map((b: Anthropic.TextBlock) => b.text)
    .join("");
}

export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(config: AnthropicConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined,
    });
  }

  async complete(messages: ChatMessage[], opts?: LLMOptions): Promise<string> {
    const { system, rest } = splitSystem(messages);
    const res = await this.client.messages.create({
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature,
      system,
      messages: rest,
    });
    return textOf(res);
  }

  async *stream(
    messages: ChatMessage[],
    opts?: LLMOptions,
  ): AsyncIterable<string> {
    const { system, rest } = splitSystem(messages);
    const stream = this.client.messages.stream({
      model: opts?.model ?? this.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature,
      system,
      messages: rest,
    });
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }

  async structured<T>(
    messages: ChatMessage[],
    schema: ZodType<T>,
    opts?: LLMOptions,
  ): Promise<T> {
    const model = opts?.model ?? this.model;
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const { system, rest } = splitSystem(messages);

    const inputSchema = toJsonSchema(schema) as Anthropic.Tool.InputSchema;
    const tool: Anthropic.Tool = {
      name: STRUCTURED_TOOL_NAME,
      description:
        "Emit the final result. Call this exactly once with arguments matching the schema.",
      input_schema: inputSchema,
    };

    // Primary path: force the tool and validate its structured input.
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: opts?.temperature,
        system,
        messages: rest,
        tools: [tool],
        tool_choice: { type: "tool", name: STRUCTURED_TOOL_NAME },
      });
      const toolUse = res.content.find(
        (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock =>
          b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
      );
      if (toolUse) {
        const validated = schema.safeParse(toolUse.input);
        if (validated.success) return validated.data;
        // Tool input present but invalid → fall through to the text retry.
      }
    } catch {
      // Tool use unsupported / rejected by the endpoint → JSON-in-text fallback.
    }

    // Fallback path: JSON-in-text, mirroring the openai-compatible adapter.
    const fallbackSystem = [structuredSystemInstruction(schema), system]
      .filter(Boolean)
      .join("\n\n");

    const firstRes = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: opts?.temperature,
      system: fallbackSystem,
      messages: rest,
    });
    const raw = textOf(firstRes);
    const first = tryParse(raw, schema);
    if (first.ok) return first.value;

    // Retry once with an error-correcting follow-up.
    const retryMessages: Anthropic.MessageParam[] = [
      ...rest,
      { role: "assistant", content: raw },
      { role: "user", content: structuredRetryInstruction(first.reason) },
    ];
    const retryRes = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: opts?.temperature,
      system: fallbackSystem,
      messages: retryMessages,
    });
    const retryRaw = textOf(retryRes);
    const second = tryParse(retryRaw, schema);
    if (second.ok) return second.value;

    throw new Error(
      `Structured output failed after retry. ${second.reason}\nLast model output:\n${retryRaw}`,
    );
  }
}
