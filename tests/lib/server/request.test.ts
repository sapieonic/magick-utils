import { describe, expect, it } from "vitest";

import { parseJsonBody } from "@/lib/server/request";

describe("bounded JSON request parsing", () => {
  it("parses a normal JSON request", async () => {
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ ok: true }) });
    await expect(parseJsonBody(req)).resolves.toEqual({ ok: true });
  });

  it("rejects malformed JSON", async () => {
    const req = new Request("http://localhost", { method: "POST", body: "{" });
    await expect(parseJsonBody(req)).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  it("rejects declared and streamed bodies over the byte limit", async () => {
    const declared = new Request("http://localhost", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "{}",
    });
    await expect(parseJsonBody(declared, 10)).rejects.toMatchObject({ status: 413, code: "body_too_large" });

    const streamed = new Request("http://localhost", { method: "POST", body: JSON.stringify({ value: "x".repeat(20) }) });
    await expect(parseJsonBody(streamed, 10)).rejects.toMatchObject({ status: 413, code: "body_too_large" });
  });
});
