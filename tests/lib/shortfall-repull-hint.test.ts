import { describe, expect, it } from "vitest";
import { SHORT_PULL_REPULL_COOLDOWN_MS, repullHint } from "@/lib/shortfall";
import { SHORT_PULL_REPULL_COOLDOWN_MS as SERVER_COOLDOWN } from "@/lib/server/types";

describe("repullHint", () => {
  it("quotes the cooldown the merge actually obeys", () => {
    // One constant, re-exported for the server: the copy cannot drift from it.
    expect(SERVER_COOLDOWN).toBe(SHORT_PULL_REPULL_COOLDOWN_MS);
    const minutes = SHORT_PULL_REPULL_COOLDOWN_MS / 60_000;
    expect(repullHint("Download")).toContain(`Download again after ${minutes} minutes`);
    expect(repullHint("Generate")).toContain(`Generate again after ${minutes} minutes`);
  });

  it("points at the one re-pull that ignores the cooldown", () => {
    expect(repullHint("Download")).toMatch(/Refresh data in Analytics to re-pull now/);
  });
});
