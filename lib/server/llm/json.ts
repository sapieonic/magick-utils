// Small shared helpers for the `structured()` correctness path. Used by both
// the openai-compatible and anthropic adapters so the parse/validate/retry
// behaviour is identical regardless of vendor.

import { z, type ZodType } from "zod";

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) and surrounding
 * whitespace so `JSON.parse` sees clean JSON. Returns the inner content if a
 * fence is found, otherwise the trimmed input.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // ```lang\n...\n``` — capture the body regardless of language tag.
  const fenced = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/**
 * Find the index of the character that closes the balanced JSON region opened
 * at `start` (which must point at a `{` or `[`). Honours string literals and
 * escape sequences so delimiters inside quoted strings don't affect the
 * balance. Returns -1 if the region never closes (truncated output).
 */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Extract every top-level balanced JSON object/array embedded in `text`, in
 * order of appearance. Nested structures are part of their enclosing region
 * (not returned separately), and an unbalanced/truncated region is skipped.
 * Models sometimes wrap their JSON in prose ("We found ...{...}"), trail
 * commentary after it, or lead with an unrelated bracketed aside; this surfaces
 * each candidate so the caller can pick the one that validates.
 */
export function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = balancedEnd(text, i);
      if (end !== -1) {
        out.push(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/**
 * The first balanced JSON object/array embedded in `text`, or `null` if none is
 * found. Convenience over {@link extractJsonCandidates} for callers that only
 * need the leading candidate.
 */
export function extractJsonCandidate(text: string): string | null {
  return extractJsonCandidates(text)[0] ?? null;
}

/** Convert a zod schema to a JSON Schema object for prompting / tool input. */
export function toJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  // zod v4 ships z.toJSONSchema. Target draft-2020-12 and inline refs so the
  // result is self-contained and easy for models / tool APIs to consume.
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as Record<string, unknown>;
}

/** A compact JSON-schema string to embed in a prompt. */
export function schemaPrompt(schema: ZodType<unknown>): string {
  return JSON.stringify(toJsonSchema(schema), null, 2);
}

/** Format a zod error into a short, model-actionable list of problems. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i: z.ZodIssue) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * Parse `raw` as JSON and validate against `schema`. On success returns the
 * typed value; on failure returns a structured error describing what went
 * wrong (used to build the error-correcting retry prompt).
 */
export function tryParse<T>(
  raw: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; reason: string } {
  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Direct parse failed — the model may have wrapped the JSON in prose (e.g.
    // "We found ...{...}"), trailed commentary after it, or led with an
    // unrelated bracketed aside. Recover by scanning for balanced JSON regions
    // and preferring one that satisfies the schema; otherwise keep the first
    // that at least parses, so a schema-mismatch (not a bare syntax error) is
    // what surfaces to the retry.
    let recovered: { value: unknown } | undefined;
    for (const candidate of extractJsonCandidates(cleaned)) {
      let value: unknown;
      try {
        value = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (recovered === undefined) recovered = { value };
      if (schema.safeParse(value).success) {
        recovered = { value };
        break;
      }
    }
    if (recovered === undefined) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `Output was not valid JSON (${msg}).` };
    }
    parsed = recovered.value;
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: `JSON did not match the required schema:\n${formatZodError(result.error)}`,
  };
}

/** The system-level instruction appended for structured output. */
export function structuredSystemInstruction(schema: ZodType<unknown>): string {
  return [
    "You must respond with a single JSON object that conforms exactly to the following JSON Schema.",
    "Do not include any prose, explanation, or markdown code fences — output raw JSON only.",
    "",
    "JSON Schema:",
    schemaPrompt(schema),
  ].join("\n");
}

/** The follow-up message used when the first structured attempt failed. */
export function structuredRetryInstruction(reason: string): string {
  return [
    "Your previous response could not be used. " + reason,
    "",
    "Return ONLY a corrected JSON object that conforms exactly to the schema. No prose, no code fences.",
  ].join("\n");
}
