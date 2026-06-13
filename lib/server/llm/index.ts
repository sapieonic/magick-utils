// LLM layer entry point. `getLLM()` returns the configured provider; callers
// depend on the `LLMProvider` contract, never a concrete vendor.

import { z } from "zod";

import { env, isLlmConfigured } from "@/lib/server/env";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

export type { ChatMessage, LLMOptions, LLMProvider } from "./types";
export { OpenAICompatibleProvider } from "./openai-compatible";
export { AnthropicProvider } from "./anthropic";

/**
 * Build the configured LLM provider. Throws a descriptive error when the LLM
 * env config is incomplete (callers should gate on `isLlmConfigured()` first
 * for graceful degradation).
 */
export function getLLM(): LLMProvider {
  if (!isLlmConfigured()) {
    throw new Error(
      "LLM is not configured. Set LLM_API_KEY and LLM_MODEL (and LLM_BASE_URL " +
        "for openai-compatible hosts). See lib/server/env.ts.",
    );
  }

  const { provider, model, baseUrl, apiKey } = env.llm;

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey, model, baseUrl });
    case "openai-compatible":
      return new OpenAICompatibleProvider({ apiKey, model, baseUrl });
    default: {
      // Exhaustiveness guard — surfaces a clear error if a new provider value
      // is added to env without a matching adapter.
      const exhaustive: never = provider;
      throw new Error(`Unsupported LLM provider: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Insight schema — the structured shape AI insights produce. Maps 1:1 onto the
// `Anomaly` / `Recommendation` / `Insight` server contracts in
// lib/server/types.ts (narrative + anomalies + recommendations). The model
// returns only the analytical fields; bookkeeping (tenant, key, model,
// createdAt, etc.) is attached by the caller.
// ---------------------------------------------------------------------------

export const ANOMALY_SCHEMA = z.object({
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});

export const RECOMMENDATION_SCHEMA = z.object({
  title: z.string(),
  detail: z.string(),
});

export const INSIGHT_SCHEMA = z.object({
  narrative: z.string(),
  anomalies: z.array(ANOMALY_SCHEMA),
  recommendations: z.array(RECOMMENDATION_SCHEMA),
});

/** The model-produced portion of an `Insight` (everything except bookkeeping). */
export type InsightPayload = z.infer<typeof INSIGHT_SCHEMA>;
export type AnomalyPayload = z.infer<typeof ANOMALY_SCHEMA>;
export type RecommendationPayload = z.infer<typeof RECOMMENDATION_SCHEMA>;
