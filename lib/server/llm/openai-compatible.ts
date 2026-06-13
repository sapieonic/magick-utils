// OpenAI-compatible adapter. Works against any endpoint that speaks the OpenAI
// Chat Completions API: OpenAI, DeepSeek, Kimi/Moonshot, OpenRouter, vLLM,
// Ollama, etc. Selected when env.llm.provider === "openai-compatible".

import OpenAI from "openai";
import type { ZodType } from "zod";

import {
  structuredRetryInstruction,
  structuredSystemInstruction,
  tryParse,
} from "./json";
import type { ChatMessage, LLMOptions, LLMProvider } from "./types";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(messages: ChatMessage[]): ChatParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatibleConfig) {
    this.model = config.model;
    // `baseURL` is what makes this provider-agnostic — any compatible host works.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      // Fall back to the SDK default (OpenAI) when no baseUrl is configured.
      baseURL: config.baseUrl || undefined,
    });
  }

  async complete(messages: ChatMessage[], opts?: LLMOptions): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: opts?.model ?? this.model,
      messages: toOpenAIMessages(messages),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: false,
    });
    return res.choices[0]?.message?.content ?? "";
  }

  async *stream(
    messages: ChatMessage[],
    opts?: LLMOptions,
  ): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: opts?.model ?? this.model,
      messages: toOpenAIMessages(messages),
      temperature: opts?.temperature,
      max_tokens: opts?.maxTokens,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async structured<T>(
    messages: ChatMessage[],
    schema: ZodType<T>,
    opts?: LLMOptions,
  ): Promise<T> {
    const model = opts?.model ?? this.model;

    // Prepend a system instruction carrying the JSON shape. If the caller
    // already leads with a system message, keep theirs first and add ours.
    const base: ChatMessage[] = [
      { role: "system", content: structuredSystemInstruction(schema) },
      ...messages,
    ];

    const request = (msgs: ChatMessage[]) =>
      this.client.chat.completions.create({
        model,
        messages: toOpenAIMessages(msgs),
        temperature: opts?.temperature,
        max_tokens: opts?.maxTokens,
        // Prefer native JSON mode where available; harmless on hosts that
        // ignore it, and we still validate the result ourselves.
        response_format: { type: "json_object" },
        stream: false,
      });

    let raw: string;
    try {
      const res = await request(base);
      raw = res.choices[0]?.message?.content ?? "";
    } catch {
      // Some compatible hosts reject `response_format`. Retry without it.
      const res = await this.client.chat.completions.create({
        model,
        messages: toOpenAIMessages(base),
        temperature: opts?.temperature,
        max_tokens: opts?.maxTokens,
        stream: false,
      });
      raw = res.choices[0]?.message?.content ?? "";
    }

    const first = tryParse(raw, schema);
    if (first.ok) return first.value;

    // Retry once with an error-correcting follow-up that includes the model's
    // bad output and the validation failure.
    const retryMessages: ChatMessage[] = [
      ...base,
      { role: "assistant", content: raw },
      { role: "user", content: structuredRetryInstruction(first.reason) },
    ];

    let retryRaw: string;
    try {
      const res = await request(retryMessages);
      retryRaw = res.choices[0]?.message?.content ?? "";
    } catch {
      const res = await this.client.chat.completions.create({
        model,
        messages: toOpenAIMessages(retryMessages),
        temperature: opts?.temperature,
        max_tokens: opts?.maxTokens,
        stream: false,
      });
      retryRaw = res.choices[0]?.message?.content ?? "";
    }

    const second = tryParse(retryRaw, schema);
    if (second.ok) return second.value;

    throw new Error(
      `Structured output failed after retry. ${second.reason}\nLast model output:\n${retryRaw}`,
    );
  }
}
