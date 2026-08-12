import { describe, expect, it } from "vitest";
import {
  assembleDashboardQuality,
  computeDashboardQuality,
  durationBucket,
  emptyDashboardVolume,
  formatIvrPath,
  HANGUP_TALK_SECONDS,
  humanizeKey,
  isIvrHangupNode,
  parseIvrPath,
  SHORT_CALL_SECONDS,
  type QualityRecord,
} from "@/lib/server/dashboard-quality";

function rec(overrides: Partial<QualityRecord> = {}): QualityRecord {
  return { selType: "ai", status: "completed", ...overrides };
}

describe("parseIvrPath / formatIvrPath", () => {
  it("splits on >, /, and | and trims empty segments", () => {
    expect(parseIvrPath("main>billing>agent")).toEqual(["main", "billing", "agent"]);
    expect(parseIvrPath("main / billing / agent")).toEqual(["main", "billing", "agent"]);
    expect(parseIvrPath("main|optout")).toEqual(["main", "optout"]);
    expect(parseIvrPath("  main >  > end ")).toEqual(["main", "end"]);
    expect(parseIvrPath("")).toEqual([]);
    expect(parseIvrPath(null)).toEqual([]);
  });

  it("formats paths with a readable separator", () => {
    expect(formatIvrPath(["main", "billing", "agent"])).toBe("main › billing › agent");
  });
});

describe("humanizeKey / hang-up nodes / duration buckets", () => {
  it("title-cases snake and kebab keys", () => {
    expect(humanizeKey("promise_to_pay")).toBe("Promise To Pay");
    expect(humanizeKey("agent-transfer")).toBe("Agent Transfer");
  });

  it("recognizes hang-up terminal nodes", () => {
    expect(isIvrHangupNode("hangup")).toBe(true);
    expect(isIvrHangupNode("Hang-up")).toBe(true);
    expect(isIvrHangupNode("caller hangup")).toBe(true);
    expect(isIvrHangupNode("timeout")).toBe(true);
    expect(isIvrHangupNode("agent_transfer")).toBe(false);
    expect(isIvrHangupNode("")).toBe(false);
  });

  it("buckets durations the same way as analytics", () => {
    expect(durationBucket(0)).toBe("0–30s");
    expect(durationBucket(29.9)).toBe("0–30s");
    expect(durationBucket(30)).toBe("30–60s");
    expect(durationBucket(119)).toBe("1–2m");
    expect(durationBucket(300)).toBe("5m+");
  });
});

describe("computeDashboardQuality", () => {
  it("returns empty quality for no records", () => {
    expect(computeDashboardQuality([])).toEqual({
      voiceConnectMix: [],
      messageFunnel: [],
      outcomes: [],
      shortCalls: null,
      ivrDropoff: null,
    });
  });

  it("splits voice connect mix and ignores messages", () => {
    const mix = computeDashboardQuality([
      rec({ status: "completed" }),
      rec({ status: "noanswer", raw: { status: "no_answer" } }),
      rec({ status: "failed", raw: { status: "switched_off" } }),
      rec({ selType: "message", status: "read" }),
    ]).voiceConnectMix;
    expect(mix).toEqual([
      { key: "completed", value: 1 },
      { key: "noanswer", value: 1 },
      { key: "switchedoff", value: 1 },
    ]);
  });

  it("builds a message funnel including replies", () => {
    const funnel = computeDashboardQuality([
      rec({ selType: "message", status: "sent" }),
      rec({ selType: "message", status: "delivered" }),
      rec({ selType: "message", status: "read", replyText: "STOP" }),
      rec({ selType: "message", status: "read", replyText: "  " }),
      rec({ selType: "ai", status: "completed" }),
    ]).messageFunnel;
    expect(funnel).toEqual([
      { stage: "Sent", value: 4 },
      { stage: "Delivered", value: 3 },
      { stage: "Read", value: 2 },
      { stage: "Replied", value: 1 },
    ]);
  });

  it("rolls up outcomes and collapses the long tail into Other", () => {
    const records = [
      rec({ outcome: "promise_to_pay" }),
      rec({ outcome: "Promise_To_Pay" }),
      rec({ outcome: "callback" }),
      rec({ outcome: "  " }),
      rec({ outcome: null }),
      ...["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => rec({ outcome: key })),
    ];
    const outcomes = computeDashboardQuality(records).outcomes;
    expect(outcomes[0]).toMatchObject({ key: "promise_to_pay", value: 2, label: "Promise To Pay" });
    expect(outcomes.find((o) => o.key === "other")?.value).toBe(2);
    expect(outcomes).toHaveLength(9);
  });

  it("counts short calls and hang-ups on connected calls only", () => {
    const stats = computeDashboardQuality([
      rec({ durationSeconds: 8, talkTimeSeconds: 4 }),
      rec({ durationSeconds: 40, talkTimeSeconds: 28 }),
      rec({ durationSeconds: 12, talkTimeSeconds: 12 }),
      rec({ status: "noanswer", durationSeconds: 5, talkTimeSeconds: 0 }),
      rec({ selType: "message", status: "read", durationSeconds: 3 }),
      rec({ durationSeconds: 90 }),
    ]).shortCalls;
    expect(stats).not.toBeNull();
    expect(stats!.thresholdSeconds).toBe(SHORT_CALL_SECONDS);
    expect(stats!.hangupTalkSeconds).toBe(HANGUP_TALK_SECONDS);
    expect(stats!.connectedWithDuration).toBe(4);
    expect(stats!.shortCount).toBe(2);
    expect(stats!.shortRate).toBe(0.5);
    expect(stats!.connectedWithTalk).toBe(3);
    expect(stats!.hangupCount).toBe(1);
    expect(stats!.hangupRate).toBeCloseTo(1 / 3);
    expect(stats!.avgDuration).toBeCloseTo((8 + 40 + 12 + 90) / 4);
    expect(stats!.durationHistogram.find((b) => b.bucket === "0–30s")?.calls).toBe(2);
  });

  it("returns null short-call stats when no connected durations exist", () => {
    expect(computeDashboardQuality([
      rec({ status: "noanswer", durationSeconds: 8 }),
    ]).shortCalls).toBeNull();
  });

  it("builds IVR drop-off from path depth, terminal node, and DTMF", () => {
    const ivr = computeDashboardQuality([
      rec({ selType: "ivr", ivrPath: "main>billing>agent", completedNode: "agent_transfer", dtmfInput: "1" }),
      rec({ selType: "ivr", ivrPath: "main>optout", completedNode: "hangup", dtmfInput: "9" }),
      rec({ selType: "ivr", ivrPath: "main>billing>self_serve", completedNode: "self_serve", dtmfInput: "1" }),
      rec({ selType: "ivr", ivrPath: "main", completedNode: "timeout" }),
      rec({ selType: "ai", ivrPath: "main>agent", completedNode: "hangup" }),
    ]).ivrDropoff;
    expect(ivr).not.toBeNull();
    expect(ivr!.totalIvr).toBe(4);
    expect(ivr!.withPath).toBe(4);
    expect(ivr!.hangupCount).toBe(2);
    expect(ivr!.depthFunnel.map((s) => s.value)).toEqual([4, 3, 2, 0]);
    expect(ivr!.topPaths).toEqual(expect.arrayContaining([
      { path: "main › billing › agent", value: 1 },
      { path: "main › optout", value: 1 },
    ]));
    expect(ivr!.dtmf).toEqual([
      { input: "1", value: 2 },
      { input: "9", value: 1 },
    ]);
    expect(ivr!.completedNodes.find((n) => n.key === "hangup")?.value).toBe(1);
    expect(ivr!.completedNodes.find((n) => n.key === "timeout")?.value).toBe(1);
  });
});

describe("assembleDashboardQuality", () => {
  it("rebuilds the same shape from Mongo $facet rows", () => {
    const quality = assembleDashboardQuality({
      voiceConnect: [
        { _id: "completed", value: 8 },
        { _id: "noanswer", value: 3 },
      ],
      messageFunnel: [{ sent: 10, delivered: 8, read: 5, replied: 2 }],
      outcomes: [
        { _id: "callback", value: 4 },
        { _id: "promise_to_pay", value: 7 },
      ],
      shortCalls: [{
        withDuration: 8,
        shortCount: 2,
        hangupCount: 1,
        withTalk: 7,
        durationSum: 400,
        talkSum: 210,
      }],
      shortCallBuckets: [{ _id: "0–30s", calls: 2 }, { _id: "1–2m", calls: 6 }],
      ivrEnds: [{ _id: "hangup", value: 2 }, { _id: "agent_transfer", value: 5 }],
      ivrPaths: [{ _id: "main>optout", value: 3 }],
      ivrDtmf: [{ _id: "1", value: 4 }],
      ivrDepth: [{ total: 7, withPath: 6, hangupCount: 2, d1: 6, d2: 3, d3: 1, d4: 0 }],
    });
    expect(quality.voiceConnectMix).toEqual([
      { key: "completed", value: 8 },
      { key: "noanswer", value: 3 },
    ]);
    expect(quality.messageFunnel[0]).toEqual({ stage: "Sent", value: 10 });
    expect(quality.outcomes[0]).toMatchObject({ key: "promise_to_pay", value: 7 });
    expect(quality.shortCalls?.shortRate).toBe(0.25);
    expect(quality.shortCalls?.avgDuration).toBe(50);
    expect(quality.ivrDropoff?.hangupRate).toBeCloseTo(2 / 7);
    expect(quality.ivrDropoff?.topPaths[0]).toEqual({ path: "main › optout", value: 3 });
  });

  it("treats empty facet branches as empty quality", () => {
    expect(assembleDashboardQuality({})).toEqual(computeDashboardQuality([]));
  });
});

describe("emptyDashboardVolume", () => {
  it("fills quality fields so the dashboard never sees undefined mixes", () => {
    const volume = emptyDashboardVolume("Last 7 days", new Date("2026-08-06T00:00:00Z"), new Date("2026-08-12T12:00:00Z"));
    expect(volume.voiceConnectMix).toEqual([]);
    expect(volume.messageFunnel).toEqual([]);
    expect(volume.outcomes).toEqual([]);
    expect(volume.shortCalls).toBeNull();
    expect(volume.ivrDropoff).toBeNull();
    expect(volume.totalRecords).toBe(0);
  });
});
