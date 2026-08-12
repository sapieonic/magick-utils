export const MAX_JSON_BODY_BYTES = 256 * 1024;

export class JsonBodyError extends Error {
  constructor(readonly status: 400 | 413, readonly code: "invalid_json" | "body_too_large") {
    super(code);
    this.name = "JsonBodyError";
  }
}

/** Parse JSON with a streaming byte cap so req.json() cannot allocate an
 * unbounded attacker-controlled body before validation. */
export async function parseJsonBody<T>(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<T> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new JsonBodyError(413, "body_too_large");
  }
  if (!req.body) throw new JsonBodyError(400, "invalid_json");
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new JsonBodyError(413, "body_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw new JsonBodyError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}

export function jsonBodyErrorResponse(error: unknown): Response | null {
  if (!(error instanceof JsonBodyError)) return null;
  return Response.json({ error: error.code }, { status: error.status });
}
