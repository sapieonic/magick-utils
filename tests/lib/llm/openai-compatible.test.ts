import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Shared mock for the OpenAI chat.completions.create method. Each test sets its
// queued responses; the mock returns them in order.
const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_cfg: unknown) {}
  },
}));

// Import AFTER the mock is registered.
import { OpenAICompatibleProvider } from "@/lib/server/llm/openai-compatible";

const schema = z.object({ answer: z.string(), score: z.number() });

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

function makeProvider() {
  return new OpenAICompatibleProvider({
    apiKey: "sk-test",
    baseUrl: "https://example.test/v1",
    model: "gpt-x",
  });
}

beforeEach(() => {
  createMock.mockReset();
});

describe("OpenAICompatibleProvider.structured", () => {
  it("returns the parsed value when the first response is valid JSON (no retry)", async () => {
    createMock.mockResolvedValueOnce(
      completion(JSON.stringify({ answer: "yes", score: 1 })),
    );
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "yes", score: 1 });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("prepends the structured system instruction and requests json_object format", async () => {
    createMock.mockResolvedValueOnce(
      completion(JSON.stringify({ answer: "y", score: 0 })),
    );
    const provider = makeProvider();
    await provider.structured([{ role: "user", content: "go" }], schema);

    const arg = createMock.mock.calls[0][0];
    expect(arg.response_format).toEqual({ type: "json_object" });
    expect(arg.messages[0].role).toBe("system");
    expect(arg.messages[0].content).toContain("JSON Schema:");
    expect(arg.model).toBe("gpt-x");
  });

  it("parses fenced JSON from the model", async () => {
    createMock.mockResolvedValueOnce(
      completion('```json\n{"answer":"y","score":3}\n```'),
    );
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "y", score: 3 });
  });

  it("retries once with the correction instruction, then returns the corrected value", async () => {
    createMock
      .mockResolvedValueOnce(completion("not json at all"))
      .mockResolvedValueOnce(
        completion(JSON.stringify({ answer: "fixed", score: 9 })),
      );
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "fixed", score: 9 });
    expect(createMock).toHaveBeenCalledTimes(2);

    // The retry call carries the assistant's bad output + a user correction msg.
    const retryArg = createMock.mock.calls[1][0];
    const msgs = retryArg.messages;
    const assistant = msgs.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.content).toBe("not json at all");
    const lastUser = msgs[msgs.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("could not be used");
    expect(lastUser.content).toContain("No prose, no code fences");
  });

  it("throws after the retry also fails, including the last model output", async () => {
    createMock
      .mockResolvedValueOnce(completion("garbage"))
      .mockResolvedValueOnce(completion("still garbage"));
    const provider = makeProvider();
    await expect(
      provider.structured([{ role: "user", content: "go" }], schema),
    ).rejects.toThrow(/Structured output failed after retry/);
  });

  it("throws when the retry returns valid JSON that still violates the schema", async () => {
    createMock
      .mockResolvedValueOnce(completion("nope"))
      .mockResolvedValueOnce(completion(JSON.stringify({ answer: "y" }))); // missing score
    const provider = makeProvider();
    await expect(
      provider.structured([{ role: "user", content: "go" }], schema),
    ).rejects.toThrow(/Structured output failed after retry/);
  });

  it("falls back to a request without response_format when the host rejects json_object", async () => {
    // First call (with response_format) throws; the adapter retries the SAME
    // attempt without response_format and that succeeds.
    createMock
      .mockRejectedValueOnce(new Error("response_format unsupported"))
      .mockResolvedValueOnce(
        completion(JSON.stringify({ answer: "ok", score: 2 })),
      );
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "ok", score: 2 });
    expect(createMock).toHaveBeenCalledTimes(2);
    // The fallback call must NOT include response_format.
    const fallbackArg = createMock.mock.calls[1][0];
    expect(fallbackArg.response_format).toBeUndefined();
  });

  it("keeps a caller-supplied system message and adds the structured one first", async () => {
    createMock.mockResolvedValueOnce(
      completion(JSON.stringify({ answer: "y", score: 0 })),
    );
    const provider = makeProvider();
    await provider.structured(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "go" },
      ],
      schema,
    );
    const msgs = createMock.mock.calls[0][0].messages;
    expect(msgs[0].content).toContain("JSON Schema:"); // structured instruction first
    expect(msgs[1].content).toBe("be terse"); // caller's system kept
  });
});

describe("OpenAICompatibleProvider.complete", () => {
  it("returns the assistant text and passes opts through", async () => {
    createMock.mockResolvedValueOnce(completion("hello"));
    const provider = makeProvider();
    const out = await provider.complete([{ role: "user", content: "hi" }], {
      temperature: 0.2,
      maxTokens: 100,
      model: "override-model",
    });
    expect(out).toBe("hello");
    const arg = createMock.mock.calls[0][0];
    expect(arg.model).toBe("override-model");
    expect(arg.temperature).toBe(0.2);
    expect(arg.max_tokens).toBe(100);
    expect(arg.stream).toBe(false);
  });

  it("returns empty string when there is no content", async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: {} }] });
    const provider = makeProvider();
    expect(await provider.complete([{ role: "user", content: "hi" }])).toBe("");
  });
});

describe("OpenAICompatibleProvider.stream", () => {
  it("yields content deltas and skips empty ones", async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: "a" } }] };
      yield { choices: [{ delta: { content: "" } }] };
      yield { choices: [{ delta: {} }] };
      yield { choices: [{ delta: { content: "b" } }] };
    }
    createMock.mockResolvedValueOnce(chunks());
    const provider = makeProvider();
    const parts: string[] = [];
    for await (const d of provider.stream([{ role: "user", content: "hi" }])) {
      parts.push(d);
    }
    expect(parts).toEqual(["a", "b"]);
    expect(createMock.mock.calls[0][0].stream).toBe(true);
  });
});
