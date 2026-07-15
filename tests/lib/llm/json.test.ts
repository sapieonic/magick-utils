import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  stripCodeFences,
  extractJsonCandidate,
  extractJsonCandidates,
  toJsonSchema,
  schemaPrompt,
  formatZodError,
  tryParse,
  structuredSystemInstruction,
  structuredRetryInstruction,
} from "@/lib/server/llm/json";
import { INSIGHT_SCHEMA } from "@/lib/server/llm";

// A representative schema reused across cases: object with string/number/array/enum.
const sampleSchema = z.object({
  name: z.string(),
  count: z.number(),
  tags: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
});

describe("stripCodeFences", () => {
  it("strips a ```json fenced block", () => {
    const input = '```json\n{"a":1}\n```';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("strips a plain ``` fenced block (no language tag)", () => {
    const input = '```\n{"a":1}\n```';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("returns the trimmed input when there is no fence", () => {
    const input = '   {"a":1}   ';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("trims leading/trailing whitespace around a fenced block", () => {
    const input = '   \n```json\n{"a":1}\n```   \n';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("handles a language tag variation (jsonc)", () => {
    const input = '```jsonc\n{"a":1}\n```';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("handles a language tag with no trailing newline before the body", () => {
    // `lang\s*\n?` — the regex tolerates a space after the lang and an optional newline.
    const input = "```js {\"a\":1}```";
    // No newline after the lang token means the body begins right after the spaces.
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("preserves inner braces / nested JSON structure", () => {
    const input = '```json\n{"a":{"b":[1,2]},"c":"}"}\n```';
    expect(stripCodeFences(input)).toBe('{"a":{"b":[1,2]},"c":"}"}');
  });

  it("returns inner content trimmed even with extra blank lines inside the fence", () => {
    const input = '```json\n\n  {"a":1}  \n\n```';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("leaves non-JSON plain text untouched (just trimmed) when unfenced", () => {
    expect(stripCodeFences("  hello world  ")).toBe("hello world");
  });
});

describe("extractJsonCandidate", () => {
  it("extracts an object prefixed by prose", () => {
    // The exact failure from the production logs: a stray word before the JSON.
    expect(extractJsonCandidate('We{"a":1}')).toBe('{"a":1}');
  });

  it("extracts an object with trailing commentary", () => {
    expect(extractJsonCandidate('{"a":1} — hope this helps!')).toBe('{"a":1}');
  });

  it("extracts an object surrounded by prose on both sides", () => {
    expect(extractJsonCandidate('Here you go: {"a":1}. Done.')).toBe('{"a":1}');
  });

  it("extracts a top-level array", () => {
    expect(extractJsonCandidate("result: [1,2,3] ok")).toBe("[1,2,3]");
  });

  it("respects nested braces and stops at the matching close", () => {
    expect(extractJsonCandidate('x {"a":{"b":[1,2]},"c":3} y')).toBe(
      '{"a":{"b":[1,2]},"c":3}',
    );
  });

  it("ignores braces that appear inside string values", () => {
    expect(extractJsonCandidate('pre {"a":"}{ not real"} post')).toBe(
      '{"a":"}{ not real"}',
    );
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJsonCandidate('{"a":"she said \\"hi\\""} tail')).toBe(
      '{"a":"she said \\"hi\\""}',
    );
  });

  it("returns null when there is no object/array delimiter", () => {
    expect(extractJsonCandidate("just some prose")).toBeNull();
  });

  it("returns null for an unbalanced (truncated) object", () => {
    expect(extractJsonCandidate('{"a":1')).toBeNull();
  });

  it("returns the first of several top-level objects", () => {
    expect(extractJsonCandidate('{"a":1}{"b":2}')).toBe('{"a":1}');
  });

  it("returns a leading array when it appears before an object", () => {
    // Structural: the first balanced region wins, whatever its kind.
    expect(extractJsonCandidate('[1,2] and {"a":1}')).toBe("[1,2]");
  });

  it("extracts an empty object", () => {
    expect(extractJsonCandidate("prefix {} suffix")).toBe("{}");
  });

  it("extracts an empty array", () => {
    expect(extractJsonCandidate("prefix [] suffix")).toBe("[]");
  });

  it("keeps arrays nested inside an object as part of that object", () => {
    expect(extractJsonCandidate('note: {"a":[1,2],"b":3}')).toBe(
      '{"a":[1,2],"b":3}',
    );
  });

  it("handles a deeply nested structure", () => {
    const json = '{"a":{"b":{"c":[{"d":1}]}}}';
    expect(extractJsonCandidate(`lead ${json} tail`)).toBe(json);
  });

  it("ignores object/array delimiters that live inside a string value", () => {
    expect(extractJsonCandidate('x {"s":"[}{]"} y')).toBe('{"s":"[}{]"}');
  });

  it("handles escaped backslashes preceding the closing quote", () => {
    // JSON value is a Windows-style path `a\b`; the escaped backslash must not
    // swallow the following quote.
    const json = '{"path":"a\\\\b"}';
    expect(extractJsonCandidate(`pre ${json} post`)).toBe(json);
    // Sanity: the extracted text really is parseable and round-trips.
    expect(JSON.parse(extractJsonCandidate(`pre ${json} post`)!)).toEqual({
      path: "a\\b",
    });
  });

  it("tolerates newlines and whitespace around and inside the JSON", () => {
    const raw = 'Here:\n\n  {\n  "a": 1\n}\n\nthanks';
    const out = extractJsonCandidate(raw)!;
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("preserves unicode content inside string values", () => {
    expect(extractJsonCandidate('r: {"msg":"héllo · 世界 🎉"}')).toBe(
      '{"msg":"héllo · 世界 🎉"}',
    );
  });

  it("returns null when the only braces are inside a quoted-but-truncated string", () => {
    // No structural JSON at all — a lone opening brace that never closes.
    expect(extractJsonCandidate("the char { on its own")).toBeNull();
  });
});

describe("extractJsonCandidates", () => {
  it("returns an empty array when there is no JSON", () => {
    expect(extractJsonCandidates("nothing to see here")).toEqual([]);
  });

  it("returns a single candidate for one embedded object", () => {
    expect(extractJsonCandidates('We{"a":1}')).toEqual(['{"a":1}']);
  });

  it("returns every top-level object in order", () => {
    expect(extractJsonCandidates('{"a":1} and {"b":2} and {"c":3}')).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it("returns a leading array and a following object as separate candidates", () => {
    expect(extractJsonCandidates('see [1,2] then {"a":1}')).toEqual([
      "[1,2]",
      '{"a":1}',
    ]);
  });

  it("does not return nested structures as separate top-level candidates", () => {
    expect(extractJsonCandidates('{"a":{"b":1},"c":[2,3]}')).toEqual([
      '{"a":{"b":1},"c":[2,3]}',
    ]);
  });

  it("skips a truncated trailing region but keeps the complete one", () => {
    expect(extractJsonCandidates('{"a":1} then {"b":')).toEqual(['{"a":1}']);
  });

  it("skips a truncated leading region and still finds a later complete one", () => {
    // The first `{` never closes; scanning must continue to the real object.
    expect(extractJsonCandidates('{"a": [1,2 {"b":2}')).toContain('{"b":2}');
  });

  it("ignores delimiters inside strings across multiple candidates", () => {
    expect(extractJsonCandidates('{"x":"}{"} {"y":2}')).toEqual([
      '{"x":"}{"}',
      '{"y":2}',
    ]);
  });
});

describe("toJsonSchema", () => {
  it("returns a JSON Schema object for a representative schema", () => {
    const js = toJsonSchema(sampleSchema);
    expect(js).toBeTypeOf("object");
    expect(js).not.toBeNull();
    // draft-2020-12 target → $schema present.
    expect(js.$schema).toContain("2020-12");
    expect(js.type).toBe("object");
    const props = js.properties as Record<string, { type?: string }>;
    expect(props.name.type).toBe("string");
    expect(props.count.type).toBe("number");
    expect(props.tags.type).toBe("array");
    // enum → either an enum array or const, depending on zod's JSON Schema output.
    expect(props.severity).toBeDefined();
  });

  it("encodes enum values", () => {
    const js = toJsonSchema(sampleSchema);
    const props = js.properties as Record<string, { enum?: unknown[] }>;
    expect(props.severity.enum).toEqual(["low", "medium", "high"]);
  });
});

describe("schemaPrompt", () => {
  it("returns a valid JSON string (pretty-printed) of the schema", () => {
    const str = schemaPrompt(sampleSchema);
    expect(str).toBeTypeOf("string");
    expect(() => JSON.parse(str)).not.toThrow();
    const parsed = JSON.parse(str);
    expect(parsed).toEqual(toJsonSchema(sampleSchema));
    // pretty-printed with 2-space indent → contains newlines.
    expect(str).toContain("\n");
  });
});

describe("formatZodError", () => {
  it("produces '- path: message' lines for nested issues", () => {
    const res = sampleSchema.safeParse({
      name: 123,
      count: "x",
      tags: "nope",
      severity: "urgent",
    });
    expect(res.success).toBe(false);
    if (res.success) return;
    const formatted = formatZodError(res.error);
    // Each line begins with "- " and contains a colon separating path and message.
    for (const line of formatted.split("\n")) {
      expect(line.startsWith("- ")).toBe(true);
      expect(line).toContain(":");
    }
    expect(formatted).toContain("name:");
    expect(formatted).toContain("count:");
  });

  it("emits a '(root)' entry for a root-level issue", () => {
    // A schema where a root-level type mismatch yields an empty path.
    const rootSchema = z.object({ a: z.string() });
    const res = rootSchema.safeParse("not-an-object");
    expect(res.success).toBe(false);
    if (res.success) return;
    const formatted = formatZodError(res.error);
    expect(formatted).toContain("(root):");
  });
});

describe("tryParse", () => {
  it("returns {ok:true,value} for valid JSON matching the schema", () => {
    const raw = JSON.stringify({
      name: "n",
      count: 2,
      tags: ["a"],
      severity: "low",
    });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      name: "n",
      count: 2,
      tags: ["a"],
      severity: "low",
    });
  });

  it("returns {ok:false} with a 'not valid JSON' reason for invalid syntax", () => {
    const r = tryParse("{ not json", sampleSchema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not valid JSON");
  });

  it("returns {ok:false} with formatted zod issues for schema mismatch", () => {
    const raw = JSON.stringify({ name: "n", count: "bad", tags: [], severity: "low" });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("did not match the required schema");
    expect(r.reason).toContain("count:");
  });

  it("recovers a valid object prefixed with prose (the production 'We{...}' case)", () => {
    const raw =
      "We" +
      JSON.stringify({ name: "n", count: 3, tags: ["x"], severity: "medium" });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ name: "n", count: 3, tags: ["x"], severity: "medium" });
  });

  it("recovers a valid object with trailing commentary", () => {
    const raw =
      JSON.stringify({ name: "n", count: 1, tags: [], severity: "low" }) +
      "\n\nLet me know if you need anything else.";
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(1);
  });

  it("still reports 'not valid JSON' when no recoverable object exists", () => {
    const r = tryParse("there is no json here at all", sampleSchema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not valid JSON");
  });

  it("parses input wrapped in code fences", () => {
    const raw =
      '```json\n' +
      JSON.stringify({ name: "n", count: 1, tags: [], severity: "high" }) +
      "\n```";
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.severity).toBe("high");
  });

  it("preserves typing through a generic schema", () => {
    const numSchema = z.number();
    const r = tryParse("42", numSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(42);
  });

  it("recovers the schema-matching object past an unrelated bracketed aside", () => {
    // Prose contains a stray array before the real object — the scanner must
    // skip the non-matching candidate and keep the one that validates.
    const raw =
      "Here are the results [see note 1]: " +
      JSON.stringify({ name: "n", count: 4, tags: ["t"], severity: "high" });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ name: "n", count: 4, tags: ["t"], severity: "high" });
  });

  it("prefers a later object when an earlier one does not match the schema", () => {
    const raw =
      'first {"unrelated":true} then ' +
      JSON.stringify({ name: "n", count: 5, tags: [], severity: "low" });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(5);
  });

  it("reports a schema mismatch (not a syntax error) for recovered-but-invalid JSON", () => {
    // The recovered object parses fine but violates the schema; the retry needs
    // the schema reason, not a generic "not valid JSON".
    const raw = 'Note: {"name":123,"count":"x","tags":"y","severity":"z"}';
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("did not match the required schema");
    expect(r.reason).toContain("count:");
    expect(r.reason).not.toContain("not valid JSON");
  });

  it("recovers JSON left as prose inside a code fence", () => {
    // stripCodeFences removes the fence; the remaining body is prose + JSON.
    const raw =
      "```\nSure, here it is: " +
      JSON.stringify({ name: "n", count: 6, tags: ["a"], severity: "medium" }) +
      "\n```";
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.severity).toBe("medium");
  });

  it("recovers a top-level array wrapped in prose against an array schema", () => {
    const arrSchema = z.array(z.number());
    const r = tryParse("The numbers are [1,2,3] in total.", arrSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([1, 2, 3]);
  });

  it("does not alter valid JSON that parses directly (no recovery path)", () => {
    const raw = JSON.stringify({ name: "n", count: 7, tags: ["z"], severity: "high" });
    const r = tryParse(raw, sampleSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(7);
  });

  it("reproduces and fixes the production insight failure ('We{...}')", () => {
    // The exact shape from the Grafana logs: a valid insight object emitted with
    // a stray leading word that made JSON.parse throw on the first character.
    const payload = {
      narrative:
        "The campaign across 59 total records achieved a success rate of only 10.2%.",
      anomalies: [
        {
          title: "Extremely low success rate",
          detail: "Only 6 of 59 records (10.2%) completed; 31 busy, 20 switched off.",
          severity: "high",
        },
        {
          title: "No spend or sentiment data",
          detail: "Telephony and AI spend are zero and sentiment/topics are empty.",
          severity: "medium",
        },
      ],
      recommendations: [
        {
          title: "Investigate call delivery issues",
          detail: "Review the contact list for invalid numbers and add retry logic.",
        },
      ],
    };
    const raw = "We" + JSON.stringify(payload);

    // Direct parse would have thrown here (this is the pre-fix failure).
    expect(() => JSON.parse(raw)).toThrow();

    const r = tryParse(raw, INSIGHT_SCHEMA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(payload);
  });
});

describe("structuredSystemInstruction", () => {
  it("includes the schema text and 'raw JSON only' guidance", () => {
    const instr = structuredSystemInstruction(sampleSchema);
    expect(instr).toContain("JSON Schema:");
    expect(instr).toContain(schemaPrompt(sampleSchema));
    expect(instr).toContain("raw JSON only");
    expect(instr).toContain("single JSON object");
  });
});

describe("structuredRetryInstruction", () => {
  it("includes the supplied reason and 'No prose, no code fences' guidance", () => {
    const reason = "JSON did not match the required schema:\n- count: Expected number";
    const instr = structuredRetryInstruction(reason);
    expect(instr).toContain(reason);
    expect(instr).toContain("could not be used");
    expect(instr).toContain("No prose, no code fences");
    expect(instr).toContain("conforms exactly to the schema");
  });
});
