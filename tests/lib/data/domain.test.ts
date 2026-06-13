import { describe, it, expect } from "vitest";
import {
  typeKey,
  selType,
  SEL_LABEL,
  SEL_ICON,
  CHANNELS,
  TYPES,
  STATUS,
  PROVIDERS,
  COLUMN_GROUPS,
} from "@/lib/data";
import type { Batch, Channel, TypeKey, StatusKey } from "@/lib/types";

describe("typeKey", () => {
  it("voice maps to its callType (ai)", () => {
    expect(typeKey({ channel: "voice", callType: "ai" })).toBe("ai");
  });
  it("voice maps to its callType (ivr)", () => {
    expect(typeKey({ channel: "voice", callType: "ivr" })).toBe("ivr");
  });
  it("messaging channels map to the channel itself", () => {
    expect(typeKey({ channel: "whatsapp", callType: null })).toBe("whatsapp");
    expect(typeKey({ channel: "telegram", callType: null })).toBe("telegram");
    expect(typeKey({ channel: "email", callType: null })).toBe("email");
  });
});

describe("selType", () => {
  it("voice maps to its callType for ai/ivr", () => {
    expect(selType({ channel: "voice", callType: "ai" })).toBe("ai");
    expect(selType({ channel: "voice", callType: "ivr" })).toBe("ivr");
  });
  it("all messaging channels collapse to 'message'", () => {
    expect(selType({ channel: "whatsapp", callType: null })).toBe("message");
    expect(selType({ channel: "telegram", callType: null })).toBe("message");
    expect(selType({ channel: "email", callType: null })).toBe("message");
  });
});

describe("SEL_LABEL / SEL_ICON", () => {
  it("SEL_LABEL has the three sel-type labels", () => {
    expect(SEL_LABEL).toEqual({ ai: "AI Call", ivr: "IVR Call", message: "Message" });
  });
  it("SEL_ICON has the three sel-type icon names", () => {
    expect(SEL_ICON).toEqual({ ai: "AudioLines", ivr: "PhoneCall", message: "MessageSquare" });
  });
});

describe("CHANNELS metadata", () => {
  const keys: Channel[] = ["voice", "whatsapp", "telegram", "email"];
  it("has exactly the four channels", () => {
    expect(Object.keys(CHANNELS).sort()).toEqual([...keys].sort());
  });
  it("each meta is well-formed and self-consistent on key", () => {
    keys.forEach((k) => {
      const m = CHANNELS[k];
      expect(m.key).toBe(k);
      expect(typeof m.label).toBe("string");
      expect(typeof m.short).toBe("string");
      expect(typeof m.icon).toBe("string");
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.soft).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.text).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
});

describe("TYPES metadata", () => {
  const keys: TypeKey[] = ["ai", "ivr", "whatsapp", "telegram", "email"];
  it("has exactly the five type keys", () => {
    expect(Object.keys(TYPES).sort()).toEqual([...keys].sort());
  });
  it("each meta is well-formed and self-consistent on key", () => {
    keys.forEach((k) => {
      const m = TYPES[k];
      expect(m.key).toBe(k);
      expect(typeof m.label).toBe("string");
      expect(typeof m.group).toBe("string");
      expect(typeof m.icon).toBe("string");
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
  it("messaging types share the 'Messages' group; voice types do not", () => {
    expect(TYPES.whatsapp.group).toBe("Messages");
    expect(TYPES.telegram.group).toBe("Messages");
    expect(TYPES.email.group).toBe("Messages");
    expect(TYPES.ai.group).toBe("AI Calls");
    expect(TYPES.ivr.group).toBe("IVR Calls");
  });
});

describe("STATUS metadata", () => {
  const keys: StatusKey[] = [
    "completed", "failed", "switchedoff", "busy", "noanswer", "voicemail",
    "inprogress", "pending", "delivered", "read", "bounced", "sent",
  ];
  it("has exactly the twelve status keys", () => {
    expect(Object.keys(STATUS).sort()).toEqual([...keys].sort());
  });
  it("each meta has label + three hex colors", () => {
    keys.forEach((k) => {
      const m = STATUS[k];
      expect(typeof m.label).toBe("string");
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.soft).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.text).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
});

describe("PROVIDERS", () => {
  it("has providers for each channel, all non-empty arrays", () => {
    (["voice", "whatsapp", "telegram", "email"] as Channel[]).forEach((c) => {
      expect(Array.isArray(PROVIDERS[c])).toBe(true);
      expect(PROVIDERS[c].length).toBeGreaterThan(0);
      PROVIDERS[c].forEach((p) => expect(typeof p).toBe("string"));
    });
  });
  it("voice has the four telephony providers", () => {
    expect(PROVIDERS.voice).toEqual(["Exotel", "Twilio", "Plivo", "Knowlarity"]);
  });
});

describe("COLUMN_GROUPS", () => {
  it("has common, ai, ivr, message groups", () => {
    expect(Object.keys(COLUMN_GROUPS).sort()).toEqual(["ai", "common", "ivr", "message"]);
  });
  it("each group has a label and a non-empty columns array of well-formed defs", () => {
    Object.values(COLUMN_GROUPS).forEach((g) => {
      expect(typeof g.label).toBe("string");
      expect(g.columns.length).toBeGreaterThan(0);
      g.columns.forEach((col) => {
        expect(typeof col.key).toBe("string");
        expect(typeof col.label).toBe("string");
        expect(typeof col.default).toBe("boolean");
      });
    });
  });
  it("column keys are unique within each group", () => {
    Object.values(COLUMN_GROUPS).forEach((g) => {
      const keys = g.columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
  it("common group includes the expected default columns", () => {
    const common = COLUMN_GROUPS.common.columns;
    const recordId = common.find((c) => c.key === "record_id");
    const provider = common.find((c) => c.key === "provider");
    expect(recordId?.default).toBe(true);
    expect(provider?.default).toBe(false);
  });
});
