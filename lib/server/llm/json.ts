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
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
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
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `Output was not valid JSON (${msg}).` };
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
