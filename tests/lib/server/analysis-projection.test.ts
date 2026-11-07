import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  createAnalysisProjectionProbe,
  needsAnalysisUpgrade,
  recordsAnalysisAuthoritative,
  recordsCarryAnalysisProjection,
  rowCarriesAnalysisProjection,
} from "@/lib/server/analysis-projection";
import { TokenRefreshPermanentError } from "@/lib/server/firebase-token";
import { MagickApiError } from "@/lib/server/magick-client";

const projectedRow = { call_id: "c1", analysis_sentiment_label: null, analysis_key_topics: null };
const legacyRow = { call_id: "c1", call_analysis: null };

describe("rowCarriesAnalysisProjection", () => {
  it("is keyed on PRESENCE: null values from a projecting core count", () => {
    expect(rowCarriesAnalysisProjection(projectedRow)).toBe(true);
    expect(rowCarriesAnalysisProjection({ analysis_sentiment_label: "positive", analysis_key_topics: ["a"] })).toBe(true);
  });

  it("is false when either key is absent, or for a non-object", () => {
    expect(rowCarriesAnalysisProjection(legacyRow)).toBe(false);
    expect(rowCarriesAnalysisProjection({ analysis_sentiment_label: null })).toBe(false);
    expect(rowCarriesAnalysisProjection({ analysis_key_topics: null })).toBe(false);
    expect(rowCarriesAnalysisProjection(null)).toBe(false);
    expect(rowCarriesAnalysisProjection(undefined)).toBe(false);
  });
});

describe("recordsCarryAnalysisProjection", () => {
  it("requires EVERY record's raw row to carry the keys", () => {
    expect(recordsCarryAnalysisProjection([{ raw: projectedRow }, { raw: projectedRow }])).toBe(true);
    // A pull that straddled a rolling core deploy: the old replica's rows were
    // not upgraded, so the batch must stay re-pullable.
    expect(recordsCarryAnalysisProjection([{ raw: projectedRow }, { raw: legacyRow }])).toBe(false);
  });

  it("is false for no records at all", () => {
    expect(recordsCarryAnalysisProjection([])).toBe(false);
  });
});

describe("needsAnalysisUpgrade", () => {
  it("is true only for an unmarked ai_voice_call batch", () => {
    expect(needsAnalysisUpgrade({ dispatchType: "ai_voice_call" })).toBe(true);
    // Undefined persists as BSON null: a null marker is "not upgraded".
    expect(needsAnalysisUpgrade({ dispatchType: "ai_voice_call", recordsAnalysisProjected: null })).toBe(true);
    expect(needsAnalysisUpgrade({ dispatchType: "ai_voice_call", recordsAnalysisProjected: false })).toBe(true);
    expect(needsAnalysisUpgrade({ dispatchType: "ai_voice_call", recordsAnalysisProjected: true })).toBe(false);
  });

  it("never applies to other surfaces, or to a batch whose surface is unknown", () => {
    for (const dispatchType of ["ivr_call", "static_call", "whatsapp_message", "email_message", undefined]) {
      expect(needsAnalysisUpgrade({ dispatchType })).toBe(false);
    }
  });
});

describe("recordsAnalysisAuthoritative", () => {
  it("is true only when every batch is marked", () => {
    expect(recordsAnalysisAuthoritative([{ recordsAnalysisProjected: true }, { recordsAnalysisProjected: true }])).toBe(true);
    expect(recordsAnalysisAuthoritative([{ recordsAnalysisProjected: true }, { recordsAnalysisProjected: null }])).toBe(false);
    expect(recordsAnalysisAuthoritative([])).toBe(false);
  });
});

describe("createAnalysisProjectionProbe", () => {
  const listCalls = vi.fn();
  beforeEach(() => listCalls.mockReset());

  it("asks for ONE row of the job on the calls list surface", async () => {
    listCalls.mockResolvedValue({ calls: [projectedRow], total: 10, limit: 1, offset: 0 });
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("job-1")).resolves.toBe(true);
    expect(listCalls).toHaveBeenCalledWith({ jobId: "job-1", limit: 1, offset: 0 });
  });

  it("answers no when the row lacks the keys (core not deployed yet)", async () => {
    listCalls.mockResolvedValue({ calls: [legacyRow], total: 10, limit: 1, offset: 0 });
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("job-1")).resolves.toBe(false);
  });

  it("reuses a definitive answer for every later batch of the request, concurrent callers included", async () => {
    listCalls.mockResolvedValue({ calls: [projectedRow], total: 10, limit: 1, offset: 0 });
    const probe = createAnalysisProjectionProbe({ listCalls });
    const answers = await Promise.all(["job-1", "job-2", "job-3"].map((id) => probe(id)));
    expect(answers).toEqual([true, true, true]);
    expect(listCalls).toHaveBeenCalledTimes(1);
  });

  it("asks the next job when one returned no row (an empty job says nothing)", async () => {
    listCalls
      .mockResolvedValueOnce({ calls: [], total: 0, limit: 1, offset: 0 })
      .mockResolvedValueOnce({ calls: [projectedRow], total: 4, limit: 1, offset: 0 });
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("empty-job")).resolves.toBe(false);
    await expect(probe("job-2")).resolves.toBe(true);
    expect(listCalls).toHaveBeenCalledTimes(2);
  });

  it("treats a failure as 'no upgrade' and does not retry it within the request", async () => {
    // Re-pulling on "unknown" would make every click during an outage another
    // full duplicate dataset; and fifty failing probes would be pure load.
    const listCalls = vi.fn(async () => {
      throw new MagickApiError(503, "down", "/proxy/calls");
    });
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("job-1")).resolves.toBe(false);
    await expect(probe("job-2")).resolves.toBe(false);
    expect(listCalls).toHaveBeenCalledTimes(1);
  });

  it("rethrows a permanently dead credential", async () => {
    const listCalls = vi.fn(async () => {
      throw new TokenRefreshPermanentError("TOKEN_EXPIRED");
    });
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("job-1")).rejects.toBeInstanceOf(TokenRefreshPermanentError);
  });

  it("never lists without a job id (that would answer for the whole account)", async () => {
    const probe = createAnalysisProjectionProbe({ listCalls });
    await expect(probe("")).resolves.toBe(false);
    expect(listCalls).not.toHaveBeenCalled();
  });
});
