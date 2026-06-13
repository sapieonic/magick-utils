import { describe, it, expect } from "vitest";
import { CAMPAIGNS, selType, typeKey, buildPreviewRows, COLUMN_GROUPS } from "@/lib/data";
import type { Batch } from "@/lib/types";

describe("CAMPAIGNS", () => {
  it("has exactly 26 entries", () => {
    expect(CAMPAIGNS).toHaveLength(26);
  });

  it("ids run cmp_1000..cmp_1025 (order-independent)", () => {
    const ids = CAMPAIGNS.map((c) => c.id).sort();
    const expected = Array.from({ length: 26 }, (_, i) => "cmp_" + (1000 + i)).sort();
    expect(ids).toEqual(expected);
  });

  it("is sorted ascending by dayAgo", () => {
    for (let i = 1; i < CAMPAIGNS.length; i++) {
      expect(CAMPAIGNS[i].dayAgo).toBeGreaterThanOrEqual(CAMPAIGNS[i - 1].dayAgo);
    }
  });

  it("each batch has all required Batch fields with valid types", () => {
    CAMPAIGNS.forEach((c) => {
      expect(typeof c.id).toBe("string");
      expect(typeof c.batchId).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(["voice", "whatsapp", "telegram", "email"]).toContain(c.channel);
      if (c.channel === "voice") {
        expect(["ai", "ivr"]).toContain(c.callType);
        expect(typeof c.avgDuration).toBe("number");
        expect(typeof c.avgTalkTime).toBe("number");
      } else {
        expect(c.callType).toBeNull();
        expect(c.avgDuration).toBeNull();
        expect(c.avgTalkTime).toBeNull();
      }
      expect(typeof c.provider).toBe("string");
      expect(typeof c.date).toBe("string");
      expect(Number.isInteger(c.dayAgo)).toBe(true);
      expect(c.dayAgo).toBeGreaterThanOrEqual(0);
      expect(c.dayAgo).toBeLessThanOrEqual(58);
      expect(c.total).toBeGreaterThan(0);
      expect(Array.isArray(c.breakdown)).toBe(true);
      expect(c.breakdown.length).toBeGreaterThan(0);
      expect(c.successRate).toBeGreaterThanOrEqual(0);
      expect(c.successRate).toBeLessThanOrEqual(1);
      expect(Number.isInteger(c.spendInr)).toBe(true);
      expect(Number.isInteger(c.telephonyInr)).toBe(true);
      expect(Number.isInteger(c.aiInr)).toBe(true);
    });
  });

  it("batch breakdown segments all have positive integer values (zeros filtered)", () => {
    CAMPAIGNS.forEach((c) => {
      c.breakdown.forEach((seg) => {
        expect(seg.value).toBeGreaterThan(0);
        expect(Number.isInteger(seg.value)).toBe(true);
      });
    });
  });

  it("successRate equals successKey value / breakdown sum", () => {
    CAMPAIGNS.forEach((c) => {
      const sum = c.breakdown.reduce((a, b) => a + b.value, 0);
      const successKey = c.channel === "voice" ? "completed" : "read";
      const seg = c.breakdown.find((b) => b.key === successKey);
      const expected = seg ? seg.value / sum : 0;
      expect(c.successRate).toBeCloseTo(expected, 10);
    });
  });

  it("voice batchIds prefixed AI-/IVR- consistent with callType; messaging uses channel prefix", () => {
    CAMPAIGNS.forEach((c) => {
      if (c.channel === "voice") {
        const expectedPrefix = c.callType === "ai" ? "AI-" : "IVR-";
        expect(c.batchId.startsWith(expectedPrefix)).toBe(true);
      } else {
        const prefix = { whatsapp: "WA-", telegram: "TG-", email: "EM-" }[c.channel];
        expect(c.batchId.startsWith(prefix)).toBe(true);
      }
    });
  });

  it("uses every channel at least once (matches the generator weighting)", () => {
    const channels = new Set(CAMPAIGNS.map((c) => c.channel));
    expect(channels).toEqual(new Set(["voice", "whatsapp", "telegram", "email"]));
  });

  it("is stable/deterministic: same reference and values across re-import", async () => {
    const again = (await import("@/lib/data")).CAMPAIGNS;
    expect(again).toBe(CAMPAIGNS); // module-level singleton
    expect(again).toEqual(CAMPAIGNS);
  });
});

describe("buildPreviewRows", () => {
  const allCommon = COLUMN_GROUPS.common.columns.map((c) => c.key);

  it("returns n rows (default 6)", () => {
    expect(buildPreviewRows(CAMPAIGNS, ["record_id"])).toHaveLength(6);
    expect(buildPreviewRows(CAMPAIGNS, ["record_id"], 3)).toHaveLength(3);
    expect(buildPreviewRows(CAMPAIGNS, ["record_id"], 10)).toHaveLength(10);
  });

  it("only includes requested columns (no extras)", () => {
    const cols = ["record_id", "campaign_name", "status"];
    const rows = buildPreviewRows(CAMPAIGNS, cols, 4);
    rows.forEach((row) => {
      expect(Object.keys(row).sort()).toEqual([...cols].sort());
    });
  });

  it("OBSERVATION: NOT fully deterministic — it draws from the shared module RNG (pick), so consecutive calls differ on randomized fields", () => {
    // buildPreviewRows seeds a LOCAL mulberry32(33) only for total_cost_inr / durations,
    // but status/outcome/sentiment/dtmf/etc. use the module-global `pick` (shared `rnd`),
    // which advances across calls. So two back-to-back calls are NOT equal.
    const a = buildPreviewRows(CAMPAIGNS, ["status", "outcome"], 6);
    const b = buildPreviewRows(CAMPAIGNS, ["status", "outcome"], 6);
    expect(a).not.toEqual(b);
  });

  it("the local-RNG fields (total_cost_inr) ARE stable across calls", () => {
    const a = buildPreviewRows(CAMPAIGNS, ["total_cost_inr"], 6).map((r) => r.total_cost_inr);
    const b = buildPreviewRows(CAMPAIGNS, ["total_cost_inr"], 6).map((r) => r.total_cost_inr);
    expect(a).toEqual(b);
  });

  it("empty campaigns array falls back to CAMPAIGNS for name/channel/provider", () => {
    const rows = buildPreviewRows([], ["campaign_name", "channel", "provider"]);
    expect(rows).toHaveLength(6);
    rows.forEach((row, i) => {
      // falls back to CAMPAIGNS[i]
      expect(row.campaign_name).toBe(CAMPAIGNS[i].name);
      expect(row.channel).toBe(typeKey(CAMPAIGNS[i]));
      expect(row.provider).toBe(CAMPAIGNS[i].provider);
    });
  });

  describe("column switch by selType", () => {
    function call(batch: Batch, cols: string[]) {
      // single-batch list -> every row uses this batch (i % 1 === 0)
      return buildPreviewRows([batch], cols, 6);
    }
    const aiBatch = CAMPAIGNS.find((c) => selType(c) === "ai")!;
    const ivrBatch = CAMPAIGNS.find((c) => selType(c) === "ivr")!;
    const msgBatch = CAMPAIGNS.find((c) => selType(c) === "message")!;

    it("record_id uses call_ prefix for calls and msg_ for messages", () => {
      expect(call(aiBatch, ["record_id"])[0].record_id).toBe("call_480021");
      expect(call(ivrBatch, ["record_id"])[1].record_id).toBe("call_480022");
      expect(call(msgBatch, ["record_id"])[0].record_id).toBe("msg_480021");
    });

    it("call_id and message_id keep their own counters", () => {
      const r = call(aiBatch, ["call_id", "message_id"]);
      expect(r[0].call_id).toBe("call_480021");
      expect(r[0].message_id).toBe("msg_771204");
      expect(r[2].call_id).toBe("call_480023");
      expect(r[2].message_id).toBe("msg_771206");
    });

    it("ai-only fields populated for ai, blank for ivr/message", () => {
      const ai = call(aiBatch, ["conversation_summary", "sentiment", "talk_time_seconds"]);
      ai.forEach((row) => {
        expect(row.conversation_summary).not.toBe("");
        expect(["positive", "neutral", "negative"]).toContain(row.sentiment);
        expect(row.talk_time_seconds).not.toBe("");
      });
      const ivr = call(ivrBatch, ["conversation_summary", "sentiment", "talk_time_seconds"]);
      ivr.forEach((row) => {
        expect(row.conversation_summary).toBe("");
        expect(row.sentiment).toBe("");
        expect(row.talk_time_seconds).toBe("");
      });
      const msg = call(msgBatch, ["conversation_summary", "sentiment", "talk_time_seconds"]);
      msg.forEach((row) => {
        expect(row.conversation_summary).toBe("");
        expect(row.sentiment).toBe("");
        expect(row.talk_time_seconds).toBe("");
      });
    });

    it("ivr-only fields populated for ivr, blank otherwise", () => {
      const ivr = call(ivrBatch, ["dtmf_input", "ivr_path", "completed_node"]);
      ivr.forEach((row) => {
        expect(["1", "2", "1#", "9", "3"]).toContain(row.dtmf_input);
        expect(row.ivr_path).not.toBe("");
        expect(row.completed_node).not.toBe("");
      });
      const ai = call(aiBatch, ["dtmf_input", "ivr_path", "completed_node"]);
      ai.forEach((row) => {
        expect(row.dtmf_input).toBe("");
        expect(row.ivr_path).toBe("");
        expect(row.completed_node).toBe("");
      });
    });

    it("message-only fields populated for message, blank otherwise", () => {
      const msg = call(msgBatch, ["template_name", "delivered_at", "read_at"]);
      msg.forEach((row) => {
        expect(["emi_reminder_v3", "kyc_drive_v1", "festive_offer"]).toContain(row.template_name);
        expect(row.delivered_at).not.toBe("");
        expect(row.read_at).not.toBe("");
      });
      const ai = call(aiBatch, ["template_name", "delivered_at", "read_at"]);
      ai.forEach((row) => {
        expect(row.template_name).toBe("");
        expect(row.delivered_at).toBe("");
        expect(row.read_at).toBe("");
      });
    });

    it("duration_seconds populated for calls, blank for messages", () => {
      call(aiBatch, ["duration_seconds"]).forEach((row) =>
        expect(row.duration_seconds).not.toBe("")
      );
      call(ivrBatch, ["duration_seconds"]).forEach((row) =>
        expect(row.duration_seconds).not.toBe("")
      );
      call(msgBatch, ["duration_seconds"]).forEach((row) =>
        expect(row.duration_seconds).toBe("")
      );
    });

    it("status picks from call vs message pools per selType", () => {
      call(aiBatch, ["status"]).forEach((row) =>
        expect(["completed", "noanswer", "busy"]).toContain(row.status)
      );
      call(msgBatch, ["status"]).forEach((row) =>
        expect(["read", "delivered", "bounced"]).toContain(row.status)
      );
    });

    it("total_cost_inr is a 2-decimal numeric string", () => {
      call(aiBatch, ["total_cost_inr"]).forEach((row) =>
        expect(row.total_cost_inr).toMatch(/^\d+\.\d{2}$/)
      );
    });

    it("bounce_reason is always blank and unknown columns default to blank", () => {
      const rows = call(msgBatch, ["bounce_reason", "totally_unknown_column"]);
      rows.forEach((row) => {
        expect(row.bounce_reason).toBe("");
        expect(row.totally_unknown_column).toBe("");
      });
    });

    it("channel column uses typeKey of the batch", () => {
      call(aiBatch, ["channel"]).forEach((row) => expect(row.channel).toBe("ai"));
      call(ivrBatch, ["channel"]).forEach((row) => expect(row.channel).toBe("ivr"));
      call(msgBatch, ["channel"]).forEach((row) =>
        expect(row.channel).toBe(typeKey(msgBatch))
      );
    });
  });
});
