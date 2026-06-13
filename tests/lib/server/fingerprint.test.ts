import { describe, it, expect } from "vitest";
import { fingerprint, batchSetKey } from "@/lib/server/fingerprint";

describe("fingerprint", () => {
  it("returns a 16-char lowercase hex string", () => {
    expect(fingerprint(["a", "b"])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same input", () => {
    expect(fingerprint(["x", 1, null])).toBe(fingerprint(["x", 1, null]));
  });

  it("is order-sensitive", () => {
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["b", "a"]));
  });

  it("coerces null/undefined to empty string (so they collide)", () => {
    expect(fingerprint([null])).toBe(fingerprint([undefined]));
    expect(fingerprint([null])).toBe(fingerprint([""]));
  });

  it("joins with | so different groupings differ", () => {
    // ["a","b"] -> "a|b"; ["ab"] -> "ab"
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["ab"]));
  });

  it("treats numbers and their string form identically", () => {
    expect(fingerprint([1])).toBe(fingerprint(["1"]));
  });

  it("handles an empty parts array", () => {
    expect(fingerprint([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("batchSetKey", () => {
  it("is order-independent (sorts ids first)", () => {
    expect(batchSetKey(["b", "a", "c"])).toBe(batchSetKey(["a", "b", "c"]));
    expect(batchSetKey(["c", "b", "a"])).toBe(batchSetKey(["a", "b", "c"]));
  });

  it("does not mutate the input array", () => {
    const ids = ["b", "a"];
    batchSetKey(ids);
    expect(ids).toEqual(["b", "a"]);
  });

  it("differs for different sets", () => {
    expect(batchSetKey(["a", "b"])).not.toBe(batchSetKey(["a", "c"]));
  });

  it("equals fingerprint of the sorted ids", () => {
    expect(batchSetKey(["b", "a"])).toBe(fingerprint(["a", "b"]));
  });
});
