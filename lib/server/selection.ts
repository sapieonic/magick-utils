import { countRecords, getBatch } from "./repositories";
import type { BatchDoc, TenantContext } from "./types";

export const MAX_SELECTION_BATCHES = 50;
export const MAX_BATCH_ID_LENGTH = 200;

export class SelectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SelectionError";
  }
}

export function parseBatchIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new SelectionError(400, "invalid_batches", "batchIds must be an array.");
  if (value.length > MAX_SELECTION_BATCHES) {
    throw new SelectionError(400, "too_many_batches", `Select at most ${MAX_SELECTION_BATCHES} batches.`);
  }
  const ids = [...new Set(value.map((id) => (typeof id === "string" ? id.trim() : "")))];
  if (ids.some((id) => !id)) throw new SelectionError(400, "invalid_batches", "Every batch id must be a non-empty string.");
  if (ids.some((id) => id.length > MAX_BATCH_ID_LENGTH)) {
    throw new SelectionError(400, "invalid_batches", `Batch ids must be at most ${MAX_BATCH_ID_LENGTH} characters.`);
  }
  if (ids.length === 0) throw new SelectionError(400, "no_batches", "Select at least one batch.");
  return ids;
}

export async function validateSelection(
  ctx: TenantContext,
  batchIds: string[],
  options: { requireReady?: boolean; verifyCounts?: boolean } = {},
): Promise<BatchDoc[]> {
  const docs = await Promise.all(batchIds.map((id) => getBatch(ctx.tenantId, ctx.accountId, id)));
  if (docs.some((doc) => doc == null)) {
    throw new SelectionError(404, "batch_not_found", "One or more selected batches do not exist in this account.");
  }
  const batches = docs as BatchDoc[];
  if (new Set(batches.map((batch) => batch.selType)).size > 1) {
    throw new SelectionError(400, "seltype_mismatch", "Select batches of the same type.");
  }
  if (options.requireReady && batches.some((batch) => batch.ingestStatus !== "ready")) {
    throw new SelectionError(409, "not_ingested", "Every selected batch must finish ingestion first.");
  }
  if (options.verifyCounts) {
    const counts = await Promise.all(batchIds.map((id) => countRecords(ctx.tenantId, ctx.accountId, [id])));
    const incomplete = batches.some((batch, index) => batch.ingestStatus !== "ready" || counts[index] !== batch.total);
    if (incomplete) {
      throw new SelectionError(409, "incomplete_ingestion", "One or more selected batches are incomplete. Run ingestion again.");
    }
  }
  return batches;
}

export function selectionErrorResponse(error: unknown): Response | null {
  if (!(error instanceof SelectionError)) return null;
  return Response.json({ error: error.code, message: error.message }, { status: error.status });
}
