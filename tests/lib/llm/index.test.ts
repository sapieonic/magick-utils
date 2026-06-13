import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `lib/server/env.ts` snapshots process.env at import time, so each test sets
// the desired env, calls vi.resetModules(), then dynamic-imports the module
// under test to read a fresh snapshot. The SDK constructors are mocked so no
// network client is actually built.

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL?: string;
    constructor(cfg: { apiKey: string; baseURL?: string }) {
      this.apiKey = cfg.apiKey;
      this.baseURL = cfg.baseURL;
    }
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    apiKey: string;
    baseURL?: string;
    constructor(cfg: { apiKey: string; baseURL?: string }) {
      this.apiKey = cfg.apiKey;
      this.baseURL = cfg.baseURL;
    }
  },
}));

const ORIGINAL_ENV = { ...process.env };

function setLlmEnv(vars: Record<string, string | undefined>) {
  for (const k of [
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_BASE_URL",
    "LLM_API_KEY",
  ]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function importLLM() {
  return import("@/lib/server/llm");
}

describe("getLLM dispatcher", () => {
  it("throws a descriptive error when LLM env is not configured", async () => {
    setLlmEnv({}); // no api key / model
    const { getLLM } = await importLLM();
    expect(() => getLLM()).toThrowError(/not configured/i);
  });

  it("throws when only the model is set (missing api key)", async () => {
    setLlmEnv({ LLM_MODEL: "gpt-x" });
    const { getLLM } = await importLLM();
    expect(() => getLLM()).toThrow();
  });

  it("returns an OpenAICompatibleProvider when provider=openai-compatible", async () => {
    setLlmEnv({
      LLM_PROVIDER: "openai-compatible",
      LLM_MODEL: "gpt-x",
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://example.test/v1",
    });
    const mod = await importLLM();
    const provider = mod.getLLM();
    expect(provider).toBeInstanceOf(mod.OpenAICompatibleProvider);
    expect(provider.model).toBe("gpt-x");
  });

  it("defaults to openai-compatible when LLM_PROVIDER is unset", async () => {
    setLlmEnv({ LLM_MODEL: "gpt-x", LLM_API_KEY: "sk-test" });
    const mod = await importLLM();
    const provider = mod.getLLM();
    expect(provider).toBeInstanceOf(mod.OpenAICompatibleProvider);
  });

  it("returns an AnthropicProvider when provider=anthropic", async () => {
    setLlmEnv({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-x",
      LLM_API_KEY: "sk-ant",
    });
    const mod = await importLLM();
    const provider = mod.getLLM();
    expect(provider).toBeInstanceOf(mod.AnthropicProvider);
    expect(provider.model).toBe("claude-x");
  });
});

describe("exported insight schemas", () => {
  it("ANOMALY_SCHEMA validates a well-formed anomaly", async () => {
    const { ANOMALY_SCHEMA } = await importLLM();
    const r = ANOMALY_SCHEMA.safeParse({
      title: "t",
      detail: "d",
      severity: "high",
    });
    expect(r.success).toBe(true);
  });

  it("ANOMALY_SCHEMA rejects an out-of-range severity", async () => {
    const { ANOMALY_SCHEMA } = await importLLM();
    const r = ANOMALY_SCHEMA.safeParse({
      title: "t",
      detail: "d",
      severity: "urgent",
    });
    expect(r.success).toBe(false);
  });

  it("INSIGHT_SCHEMA validates narrative + anomalies + recommendations", async () => {
    const { INSIGHT_SCHEMA } = await importLLM();
    const r = INSIGHT_SCHEMA.safeParse({
      narrative: "n",
      anomalies: [{ title: "t", detail: "d", severity: "low" }],
      recommendations: [{ title: "rt", detail: "rd" }],
    });
    expect(r.success).toBe(true);
  });

  it("INSIGHT_SCHEMA rejects a missing narrative", async () => {
    const { INSIGHT_SCHEMA } = await importLLM();
    const r = INSIGHT_SCHEMA.safeParse({
      anomalies: [],
      recommendations: [],
    });
    expect(r.success).toBe(false);
  });
});
