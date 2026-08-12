import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/repositories", () => ({ getBatch: vi.fn() }));

import { datasetFingerprint } from "@/lib/server/dataset";
import { getBatch } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

describe("datasetFingerprint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is order-independent but changes when an ingested batch revision changes", async () => {
    vi.mocked(getBatch).mockImplementation((_t, _a, id) => Promise.resolve({ fingerprint: `fp-${id}` } as never));
    const forward = await datasetFingerprint(ctx, ["b2", "b1"]);
    const reverse = await datasetFingerprint(ctx, ["b1", "b2"]);
    expect(forward).toBe(reverse);

    vi.mocked(getBatch).mockImplementation((_t, _a, id) => Promise.resolve({ fingerprint: id === "b1" ? "changed" : `fp-${id}` } as never));
    expect(await datasetFingerprint(ctx, ["b1", "b2"])).not.toBe(forward);
  });
});
