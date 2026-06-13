import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mocks for the Anthropic SDK: messages.create (used by complete + structured)
// and messages.stream (used by stream).
const createMock = vi.fn();
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock, stream: streamMock };
    constructor(_cfg: unknown) {}
  },
}));

import { AnthropicProvider } from "@/lib/server/llm/anthropic";

const schema = z.object({ answer: z.string(), score: z.number() });

function textMessage(text: string) {
  return { content: [{ type: "text", text }] };
}

function toolMessage(input: unknown) {
  return {
    content: [{ type: "tool_use", name: "emit_result", input }],
  };
}

function makeProvider() {
  return new AnthropicProvider({ apiKey: "sk-ant", model: "claude-x" });
}

beforeEach(() => {
  createMock.mockReset();
  streamMock.mockReset();
});

describe("AnthropicProvider.structured — tool-use primary path", () => {
  it("returns validated tool input on the first (forced-tool) call", async () => {
    createMock.mockResolvedValueOnce(toolMessage({ answer: "y", score: 5 }));
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "y", score: 5 });
    expect(createMock).toHaveBeenCalledTimes(1);
    // First call forces the emit_result tool.
    const arg = createMock.mock.calls[0][0];
    expect(arg.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    expect(arg.tools[0].name).toBe("emit_result");
    expect(arg.tools[0].input_schema).toBeTypeOf("object");
  });

  it("falls through to JSON-in-text when the tool input is invalid", async () => {
    createMock
      // Tool path returns invalid input (missing score) → falls through.
      .mockResolvedValueOnce(toolMessage({ answer: "y" }))
      // Fallback text path returns valid JSON.
      .mockResolvedValueOnce(textMessage(JSON.stringify({ answer: "z", score: 1 })));
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "z", score: 1 });
    expect(createMock).toHaveBeenCalledTimes(2);
    // The fallback call has NO tools and uses a system carrying the schema.
    const fallbackArg = createMock.mock.calls[1][0];
    expect(fallbackArg.tools).toBeUndefined();
    expect(fallbackArg.system).toContain("JSON Schema:");
  });
});

describe("AnthropicProvider.structured — text fallback path", () => {
  it("uses JSON-in-text when the tool call throws (unsupported)", async () => {
    createMock
      .mockRejectedValueOnce(new Error("tools unsupported"))
      .mockResolvedValueOnce(textMessage(JSON.stringify({ answer: "t", score: 2 })));
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "t", score: 2 });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("retries once with a correction follow-up, then returns the corrected value", async () => {
    createMock
      .mockRejectedValueOnce(new Error("no tools")) // skip tool path
      .mockResolvedValueOnce(textMessage("not json")) // first fallback bad
      .mockResolvedValueOnce(textMessage(JSON.stringify({ answer: "fixed", score: 7 })));
    const provider = makeProvider();
    const out = await provider.structured(
      [{ role: "user", content: "go" }],
      schema,
    );
    expect(out).toEqual({ answer: "fixed", score: 7 });
    expect(createMock).toHaveBeenCalledTimes(3);

    // The retry (3rd) call carries the assistant's bad text + a user correction.
    const retryArg = createMock.mock.calls[2][0];
    const msgs = retryArg.messages;
    const assistant = msgs.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.content).toBe("not json");
    const lastUser = msgs[msgs.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("could not be used");
  });

  it("throws after retry also fails", async () => {
    createMock
      .mockRejectedValueOnce(new Error("no tools"))
      .mockResolvedValueOnce(textMessage("garbage"))
      .mockResolvedValueOnce(textMessage("still garbage"));
    const provider = makeProvider();
    await expect(
      provider.structured([{ role: "user", content: "go" }], schema),
    ).rejects.toThrow(/Structured output failed after retry/);
  });

  it("merges a leading caller system message into the fallback system text", async () => {
    createMock
      .mockRejectedValueOnce(new Error("no tools"))
      .mockResolvedValueOnce(textMessage(JSON.stringify({ answer: "a", score: 0 })));
    const provider = makeProvider();
    await provider.structured(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "go" },
      ],
      schema,
    );
    const fallbackArg = createMock.mock.calls[1][0];
    expect(fallbackArg.system).toContain("JSON Schema:");
    expect(fallbackArg.system).toContain("be terse");
    // The user turn (without the system) is forwarded.
    expect(fallbackArg.messages[0].role).toBe("user");
    expect(fallbackArg.messages[0].content).toBe("go");
  });
});

describe("AnthropicProvider.complete", () => {
  it("splits system messages and returns concatenated text blocks", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Hello " },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "world" },
      ],
    });
    const provider = makeProvider();
    const out = await provider.complete([
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("Hello world");
    const arg = createMock.mock.calls[0][0];
    expect(arg.system).toBe("sys1\n\nsys2");
    expect(arg.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(arg.max_tokens).toBe(4096); // DEFAULT_MAX_TOKENS
  });

  it("folds a later stray system message into a user turn", async () => {
    createMock.mockResolvedValueOnce(textMessage("ok"));
    const provider = makeProvider();
    await provider.complete([
      { role: "user", content: "u1" },
      { role: "system", content: "stray-sys" },
    ]);
    const arg = createMock.mock.calls[0][0];
    expect(arg.system).toBeUndefined();
    expect(arg.messages).toEqual([
      { role: "user", content: "u1" },
      { role: "user", content: "stray-sys" },
    ]);
  });

  it("honors maxTokens / model / temperature opts", async () => {
    createMock.mockResolvedValueOnce(textMessage("ok"));
    const provider = makeProvider();
    await provider.complete([{ role: "user", content: "hi" }], {
      maxTokens: 50,
      model: "claude-override",
      temperature: 0.7,
    });
    const arg = createMock.mock.calls[0][0];
    expect(arg.max_tokens).toBe(50);
    expect(arg.model).toBe("claude-override");
    expect(arg.temperature).toBe(0.7);
  });
});

describe("AnthropicProvider.stream", () => {
  it("yields only text_delta events from content_block_delta", async () => {
    async function* events() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "a" } };
      yield { type: "message_start" };
      yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "b" } };
    }
    // messages.stream returns a sync async-iterable (not a promise).
    streamMock.mockReturnValueOnce(events());
    const provider = makeProvider();
    const parts: string[] = [];
    for await (const d of provider.stream([{ role: "user", content: "hi" }])) {
      parts.push(d);
    }
    expect(parts).toEqual(["a", "b"]);
  });
});
