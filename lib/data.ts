// data.ts — domain metadata, seeded mock data, chart builders, formatters.
// Ported from the design handoff (data.jsx). This is the swappable data seam:
// screens import from here; later these are backed by real API responses.

import type {
  Batch,
  Channel,
  ChannelMeta,
  ColumnGroup,
  StatusKey,
  StatusMeta,
  TypeKey,
  TypeMeta,
  Workspace,
  Currency,
} from "./types";

// ---- seeded RNG so data is stable across reloads ----
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260609);
const rint = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

// ---- channel + status metadata (consistent badges everywhere) ----
export const CHANNELS: Record<Channel, ChannelMeta> = {
  voice: { key: "voice", label: "Voice Call", short: "Voice", icon: "Phone", color: "#6366f1", soft: "#eef2ff", text: "#4338ca" },
  whatsapp: { key: "whatsapp", label: "WhatsApp", short: "WhatsApp", icon: "MessageCircle", color: "#16a34a", soft: "#dcfce7", text: "#15803d" },
  telegram: { key: "telegram", label: "Telegram", short: "Telegram", icon: "Send", color: "#0ea5e9", soft: "#e0f2fe", text: "#0369a1" },
  email: { key: "email", label: "Email", short: "Email", icon: "Mail", color: "#f59e0b", soft: "#fef3c7", text: "#b45309" },
};

// Batch "type" — voice splits into AI vs IVR; messaging channels keep identity.
export const TYPES: Record<TypeKey, TypeMeta> = {
  ai: { key: "ai", label: "AI Call", group: "AI Calls", icon: "AudioLines", color: "#7c3aed", soft: "#f5f3ff", text: "#6d28d9" },
  ivr: { key: "ivr", label: "IVR Call", group: "IVR Calls", icon: "PhoneCall", color: "#6366f1", soft: "#eef2ff", text: "#4338ca" },
  whatsapp: { key: "whatsapp", label: "WhatsApp", group: "Messages", icon: "MessageCircle", color: "#16a34a", soft: "#dcfce7", text: "#15803d" },
  telegram: { key: "telegram", label: "Telegram", group: "Messages", icon: "Send", color: "#0ea5e9", soft: "#e0f2fe", text: "#0369a1" },
  email: { key: "email", label: "Email", group: "Messages", icon: "Mail", color: "#f59e0b", soft: "#fef3c7", text: "#b45309" },
};

export const typeKey = (c: Pick<Batch, "channel" | "callType">): TypeKey =>
  (c.channel === "voice" ? (c.callType as TypeKey) : (c.channel as TypeKey));
export const selType = (c: Pick<Batch, "channel" | "callType">): "ai" | "ivr" | "message" =>
  c.channel === "voice" ? (c.callType as "ai" | "ivr") : "message";

export const SEL_LABEL: Record<"ai" | "ivr" | "message", string> = { ai: "AI Call", ivr: "IVR Call", message: "Message" };
export const SEL_ICON: Record<"ai" | "ivr" | "message", string> = { ai: "AudioLines", ivr: "PhoneCall", message: "MessageSquare" };

export const STATUS: Record<StatusKey, StatusMeta> = {
  completed: { label: "Completed", color: "#16a34a", soft: "#dcfce7", text: "#15803d" },
  failed: { label: "Failed", color: "#dc2626", soft: "#fee2e2", text: "#b91c1c" },
  switchedoff: { label: "Switched Off", color: "#9f1239", soft: "#ffe4e6", text: "#9f1239" },
  busy: { label: "Busy", color: "#fb923c", soft: "#ffedd5", text: "#c2410c" },
  noanswer: { label: "No answer", color: "#f59e0b", soft: "#fef3c7", text: "#b45309" },
  voicemail: { label: "Voicemail", color: "#64748b", soft: "#f1f5f9", text: "#334155" },
  inprogress: { label: "In Progress", color: "#8b5cf6", soft: "#ede9fe", text: "#6d28d9" },
  pending: { label: "Pending", color: "#94a3b8", soft: "#f1f5f9", text: "#475569" },
  delivered: { label: "Delivered", color: "#3b82f6", soft: "#dbeafe", text: "#1d4ed8" },
  read: { label: "Read", color: "#16a34a", soft: "#dcfce7", text: "#15803d" },
  bounced: { label: "Bounced", color: "#dc2626", soft: "#fee2e2", text: "#b91c1c" },
  sent: { label: "Sent", color: "#94a3b8", soft: "#f1f5f9", text: "#475569" },
};

export const PROVIDERS: Record<Channel, string[]> = {
  voice: ["Exotel", "Twilio", "Plivo", "Knowlarity"],
  whatsapp: ["Gupshup", "Meta Cloud", "Wati"],
  telegram: ["Telegram Bot API"],
  email: ["SendGrid", "Amazon SES"],
};

const NAME_TEMPLATES = [
  "Loan EMI Reminder", "KYC Verification Drive", "Festive Offer Blast", "Policy Renewal Nudge",
  "Delivery Confirmation", "CSAT Feedback Survey", "Payment Overdue Notice", "Appointment Reminder",
  "Cart Abandonment Recovery", "Onboarding Welcome", "Subscription Renewal", "Service Outage Notice",
  "Lead Qualification", "Collections Follow-up", "Demo Booking Outreach", "Refund Status Update",
  "Loyalty Points Expiry", "Insurance Cross-sell", "Document Collection", "Win-back Campaign",
  "Festival Greeting", "Pre-approved Offer", "Renewal Grace Reminder", "NPS Pulse Check",
];

const PREFIX: Record<Channel, string> = { voice: "VC", whatsapp: "WA", telegram: "TG", email: "EM" };

// ---- workspaces the user belongs to ----
export const WORKSPACES: Workspace[] = [
  { name: "Acme Collections", tenant: "tenant_8f2a", account: "acct_default", role: "Owner" },
  { name: "Nimbus Lending", tenant: "tenant_3c19", account: "acct_prod", role: "Admin" },
  { name: "Orchid Insurance", tenant: "tenant_71be", account: "acct_outbound", role: "Analyst" },
  { name: "BlueCart Retail", tenant: "tenant_a04d", account: "acct_marketing", role: "Analyst" },
];

// ---- generate campaigns ----
function daysAgoISO(d: number) {
  const dt = new Date("2026-06-09T10:00:00");
  dt.setDate(dt.getDate() - d);
  return dt.toISOString();
}

function buildBreakdown(channel: Channel, total: number) {
  if (channel === "voice") {
    const completed = Math.round(total * (0.42 + rnd() * 0.34));
    const noanswer = Math.round((total - completed) * (0.4 + rnd() * 0.3));
    const busy = Math.round((total - completed - noanswer) * (0.3 + rnd() * 0.3));
    const failed = Math.max(0, total - completed - noanswer - busy - rint(0, 30));
    const pending = Math.max(0, total - completed - noanswer - busy - failed);
    return [
      { key: "completed" as StatusKey, value: completed },
      { key: "noanswer" as StatusKey, value: noanswer },
      { key: "busy" as StatusKey, value: busy },
      { key: "failed" as StatusKey, value: failed },
      { key: "pending" as StatusKey, value: pending },
    ].filter((s) => s.value > 0);
  }
  const bounced = Math.round(total * (0.01 + rnd() * 0.05));
  const failed = Math.round(total * (0.005 + rnd() * 0.02));
  const delivered = total - bounced - failed;
  const read = Math.round(delivered * (0.45 + rnd() * 0.4));
  return [
    { key: "read" as StatusKey, value: read },
    { key: "delivered" as StatusKey, value: delivered - read },
    { key: "bounced" as StatusKey, value: bounced },
    { key: "failed" as StatusKey, value: failed },
  ].filter((s) => s.value > 0);
}

function generateCampaigns(): Batch[] {
  const channels: Channel[] = ["voice", "voice", "voice", "whatsapp", "whatsapp", "telegram", "email", "email"];
  const out: Batch[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < 26; i++) {
    const channel = channels[i % channels.length];
    const callType = channel === "voice" ? (i % 5 === 1 || i % 5 === 4 ? "ivr" : "ai") : null;
    let name = pick(NAME_TEMPLATES);
    let guard = 0;
    while (usedNames.has(name + channel) && guard++ < 10) name = pick(NAME_TEMPLATES);
    usedNames.add(name + channel);
    const total = channel === "voice" ? rint(1800, 14500) : rint(4200, 48000);
    const breakdown = buildBreakdown(channel, total);
    const sum = breakdown.reduce((a, b) => a + b.value, 0);
    const successKey: StatusKey = channel === "voice" ? "completed" : "read";
    const success = breakdown.find((b) => b.key === successKey);
    const successRate = success ? success.value / sum : 0;
    const perUnit = channel === "voice" ? 0.9 + rnd() * 2.6 : channel === "email" ? 0.04 + rnd() * 0.08 : 0.18 + rnd() * 0.55;
    const aiUnit = channel === "voice" ? (callType === "ai" ? 0.4 + rnd() * 1.1 : 0.04 + rnd() * 0.12) : 0.02 + rnd() * 0.06;
    const telephonyCost = total * perUnit;
    const aiCost = (channel === "voice" ? sum : total) * aiUnit;
    const spendInr = Math.round(telephonyCost + aiCost);
    const day = rint(0, 58);
    out.push({
      id: "cmp_" + (1000 + i),
      batchId: (channel === "voice" ? (callType === "ai" ? "AI" : "IVR") : PREFIX[channel]) + "-" + rint(2000, 9800),
      name,
      channel,
      callType,
      provider: pick(PROVIDERS[channel]),
      date: daysAgoISO(day),
      dayAgo: day,
      total,
      breakdown,
      successRate,
      spendInr,
      telephonyInr: Math.round(telephonyCost),
      aiInr: Math.round(aiCost),
      avgDuration: channel === "voice" ? rint(42, 165) : null,
      avgTalkTime: channel === "voice" ? rint(22, 110) : null,
    });
  }
  return out.sort((a, b) => a.dayAgo - b.dayAgo);
}

export const CAMPAIGNS: Batch[] = generateCampaigns();

// ---- aggregate dashboard stats ----
export function aggregate(list: Batch[]) {
  const totalCampaigns = list.length;
  let totalCalls = 0,
    totalMessages = 0,
    spend = 0,
    successWeighted = 0,
    denom = 0;
  list.forEach((c) => {
    const sum = c.breakdown.reduce((a, b) => a + b.value, 0);
    if (c.channel === "voice") totalCalls += sum;
    else totalMessages += sum;
    spend += c.spendInr;
    successWeighted += c.successRate * sum;
    denom += sum;
  });
  return { totalCampaigns, totalCalls, totalMessages, spendInr: spend, successRate: denom ? successWeighted / denom : 0 };
}

// ---- chart data builders ----
export function sparkline(seed: number, n = 14, base = 50, amp = 30) {
  const r = mulberry32(seed);
  let v = base;
  const out: { i: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    v += (r() - 0.45) * amp;
    v = Math.max(8, v);
    out.push({ i, v: Math.round(v) });
  }
  return out;
}

export function callsOverTime() {
  const r = mulberry32(7788);
  const out: { date: string; calls: number; messages: number }[] = [];
  for (let d = 29; d >= 0; d--) {
    const dt = new Date("2026-06-09");
    dt.setDate(dt.getDate() - d);
    const weekday = dt.getDay();
    const weekendDip = weekday === 0 || weekday === 6 ? 0.5 : 1;
    out.push({
      date: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      calls: Math.round((1200 + r() * 2600) * weekendDip),
      messages: Math.round((2600 + r() * 5200) * weekendDip),
    });
  }
  return out;
}

export function statusMix(list: Batch[]) {
  const acc: Record<string, number> = {};
  list.forEach((c) => c.breakdown.forEach((b) => { acc[b.key] = (acc[b.key] || 0) + b.value; }));
  return Object.entries(acc).map(([key, value]) => ({ key, name: STATUS[key as StatusKey].label, value, color: STATUS[key as StatusKey].color }));
}

export function durationHistogram() {
  const buckets = ["0–30s", "30–60s", "1–2m", "2–3m", "3–5m", "5m+"];
  const r = mulberry32(4242);
  return buckets.map((b, i) => ({
    bucket: b,
    calls: Math.round((i === 1 || i === 2 ? 1 : 0.5) * (400 + r() * 1800)),
    talk: Math.round((i === 1 || i === 2 ? 1 : 0.5) * (300 + r() * 1500)),
  }));
}

export function sentimentData() {
  return [
    { name: "Positive", value: 47, color: "#16a34a" },
    { name: "Neutral", value: 34, color: "#94a3b8" },
    { name: "Negative", value: 19, color: "#dc2626" },
  ];
}

export const TOPICS = [
  { topic: "Payment plan request", count: 1284, sentiment: "neutral" },
  { topic: "Already paid", count: 942, sentiment: "positive" },
  { topic: "Dispute / wrong amount", count: 731, sentiment: "negative" },
  { topic: "Callback requested", count: 688, sentiment: "neutral" },
  { topic: "Financial hardship", count: 514, sentiment: "negative" },
  { topic: "Promise to pay", count: 489, sentiment: "positive" },
  { topic: "Wrong number", count: 377, sentiment: "negative" },
  { topic: "Settlement interest", count: 296, sentiment: "positive" },
  { topic: "Language barrier", count: 211, sentiment: "neutral" },
];

export function messagingFunnel() {
  return [
    { stage: "Sent", value: 48200, color: "#94a3b8" },
    { stage: "Delivered", value: 46110, color: "#3b82f6" },
    { stage: "Read", value: 31840, color: "#16a34a" },
    { stage: "Replied", value: 9420, color: "#6366f1" },
  ];
}

// Mock best-time-to-reach matrix (feature 4b) — used when the backend is off so
// the heatmap renders in demo mode. Mirrors the real `ReachByTimeOfDay` shape
// from lib/server/types.ts; weekday is getUTCDay() (0=Sun…6=Sat), bands are
// 3h-wide. Daytime bands carry real volume; nights are sparse / low-sample.
export function reachHeatmapMock() {
  const r = mulberry32(5150);
  const bands = [2, 3, 4, 5, 6]; // 6am–9pm, the outbound window
  const cells: { weekday: number; band: number; total: number; reached: number; rate: number; lowSample: boolean }[] = [];
  let totalPlaced = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    const weekend = weekday === 0 || weekday === 6;
    for (const band of bands) {
      // Midday (bands 3–4) and Tue–Thu peak; weekends + early/late dip.
      const peak = (band === 3 || band === 4 ? 1 : 0.7) * (weekday >= 2 && weekday <= 4 ? 1 : 0.85) * (weekend ? 0.45 : 1);
      const total = Math.round((weekend ? 8 : 60 + r() * 220) * (band === 2 || band === 6 ? 0.4 : 1));
      const rate = Math.min(0.92, Math.max(0.18, 0.4 * peak + r() * 0.22));
      const reached = Math.round(total * rate);
      cells.push({ weekday, band, total, reached, rate: total > 0 ? reached / total : 0, lowSample: total < 20 });
      totalPlaced += total;
    }
  }
  return { timezone: "UTC" as const, bandHours: 3, minSamples: 20, totalPlaced, cells };
}

export function costBreakdown() {
  const r = mulberry32(9091);
  const out: { date: string; telephony: number; ai: number }[] = [];
  for (let d = 11; d >= 0; d--) {
    const dt = new Date("2026-06-09");
    dt.setDate(dt.getDate() - d * 2);
    out.push({
      date: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      telephony: Math.round(8000 + r() * 14000),
      ai: Math.round(3000 + r() * 9000),
    });
  }
  return out;
}

// ---- column picker definitions ----
export const COLUMN_GROUPS: Record<string, ColumnGroup> = {
  common: {
    label: "Common",
    columns: [
      { key: "record_id", label: "record_id", default: true },
      { key: "campaign_name", label: "campaign_name", default: true },
      { key: "channel", label: "channel", default: true },
      { key: "recipient_phone", label: "recipient_phone", default: true },
      { key: "status", label: "status", default: true },
      { key: "outcome", label: "outcome", default: true },
      { key: "timestamp", label: "timestamp", default: true },
      { key: "provider", label: "provider", default: false },
      { key: "total_cost_inr", label: "total_cost_inr", default: true },
    ],
  },
  ai: {
    label: "AI Call fields",
    columns: [
      { key: "call_id", label: "call_id", default: true },
      { key: "duration_seconds", label: "duration_seconds", default: true },
      { key: "talk_time_seconds", label: "talk_time_seconds", default: false },
      { key: "recording_url", label: "recording_url", default: false },
      { key: "transcript", label: "transcript", default: false },
      { key: "conversation_summary", label: "conversation_summary", default: true },
      { key: "sentiment", label: "sentiment", default: true },
      { key: "key_topics", label: "key_topics", default: false },
      { key: "telephony_cost_inr", label: "telephony_cost_inr", default: false },
      { key: "ai_cost_inr", label: "ai_cost_inr", default: false },
    ],
  },
  ivr: {
    label: "IVR Call fields",
    columns: [
      { key: "call_id", label: "call_id", default: true },
      { key: "duration_seconds", label: "duration_seconds", default: true },
      { key: "dtmf_input", label: "dtmf_input", default: true },
      { key: "ivr_path", label: "ivr_path", default: true },
      { key: "completed_node", label: "completed_node", default: false },
      { key: "recording_url", label: "recording_url", default: false },
      { key: "telephony_cost_inr", label: "telephony_cost_inr", default: false },
    ],
  },
  message: {
    label: "Message fields",
    columns: [
      { key: "message_id", label: "message_id", default: true },
      { key: "delivered_at", label: "delivered_at", default: true },
      { key: "read_at", label: "read_at", default: false },
      { key: "reply_text", label: "reply_text", default: false },
      { key: "template_name", label: "template_name", default: false },
      { key: "bounce_reason", label: "bounce_reason", default: false },
    ],
  },
};

// ---- preview rows for combine step 3 ----
const SAMPLE_PHONES = ["+91 98•••• 2231", "+91 99•••• 7740", "+91 81•••• 0915", "+91 70•••• 4482", "+91 96•••• 1108", "+91 73•••• 6627"];
const SAMPLE_SUMMARIES = [
  "Customer requested a 3-month EMI plan",
  "Promised to pay by Friday",
  "Disputed the outstanding amount",
  "Asked for a callback after 6pm",
  "Reported financial hardship",
  "Confirmed payment already made",
];

export function buildPreviewRows(campaigns: Batch[], columns: string[], n = 6): Record<string, string>[] {
  const r = mulberry32(33);
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    const c = campaigns[i % campaigns.length] || CAMPAIGNS[i];
    const st = c ? selType(c) : "ai";
    const isCall = st === "ai" || st === "ivr";
    const row: Record<string, string> = {};
    columns.forEach((col) => {
      switch (col) {
        case "record_id": row[col] = (isCall ? "call_" : "msg_") + (480021 + i); break;
        case "call_id": row[col] = "call_" + (480021 + i); break;
        case "message_id": row[col] = "msg_" + (771204 + i); break;
        case "campaign_name": row[col] = c ? c.name : "—"; break;
        case "channel": row[col] = c ? typeKey(c) : "—"; break;
        case "recipient_phone": row[col] = SAMPLE_PHONES[i % SAMPLE_PHONES.length]; break;
        case "status": row[col] = isCall ? pick(["completed", "noanswer", "busy"]) : pick(["read", "delivered", "bounced"]); break;
        case "outcome": row[col] = isCall ? pick(["promise_to_pay", "callback", "not_interested", "resolved", "no_response"]) : pick(["delivered", "opt_out", "replied"]); break;
        case "timestamp": row[col] = "2026-06-0" + (1 + (i % 8)) + " 14:2" + i; break;
        case "duration_seconds": row[col] = isCall ? String(rint(18, 240)) : ""; break;
        case "talk_time_seconds": row[col] = st === "ai" ? String(rint(8, 180)) : ""; break;
        case "total_cost_inr": row[col] = (isCall ? 1.5 + r() * 3 : 0.2 + r() * 0.6).toFixed(2); break;
        case "conversation_summary": row[col] = st === "ai" ? SAMPLE_SUMMARIES[i % SAMPLE_SUMMARIES.length] : ""; break;
        case "sentiment": row[col] = st === "ai" ? pick(["positive", "neutral", "negative"]) : ""; break;
        case "dtmf_input": row[col] = st === "ivr" ? pick(["1", "2", "1#", "9", "3"]) : ""; break;
        case "ivr_path": row[col] = st === "ivr" ? pick(["main>billing>agent", "main>optout", "main>repeat>end", "main>agent"]) : ""; break;
        case "completed_node": row[col] = st === "ivr" ? pick(["agent_transfer", "self_serve", "hangup", "callback"]) : ""; break;
        case "template_name": row[col] = st === "message" ? pick(["emi_reminder_v3", "kyc_drive_v1", "festive_offer"]) : ""; break;
        case "reply_text": row[col] = st === "message" ? pick(["STOP", "Yes", "Call me", ""]) : ""; break;
        case "bounce_reason": row[col] = ""; break;
        case "provider": row[col] = c ? c.provider : "—"; break;
        case "delivered_at": row[col] = st === "message" ? "2026-06-0" + (1 + (i % 8)) + " 14:2" + i : ""; break;
        case "read_at": row[col] = st === "message" ? "2026-06-0" + (1 + (i % 8)) + " 15:0" + i : ""; break;
        default: row[col] = ""; break;
      }
    });
    rows.push(row);
  }
  return rows;
}

// ---- formatting ----
export const FX = 83.4; // INR per USD
export function fmtNum(n: number | null | undefined) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-IN");
}
export function fmtCompact(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1e7) return (n / 1e7).toFixed(1) + "Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(1) + "L";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
export function fmtMoney(inr: number | null | undefined, currency: Currency) {
  if (inr == null) return "—";
  if (currency === "usd") {
    const v = inr / FX;
    return "$" + (v >= 1000 ? fmtCompact(v) : v.toFixed(0));
  }
  return "₹" + (inr >= 1000 ? fmtCompact(inr) : Math.round(inr));
}
export function fmtMoneyFull(inr: number | null | undefined, currency: Currency) {
  if (inr == null) return "—";
  if (currency === "usd") return "$" + (inr / FX).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return "₹" + Math.round(inr).toLocaleString("en-IN");
}
export function fmtPct(x: number) {
  return (x * 100).toFixed(1) + "%";
}
export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function fmtDuration(s: number | null | undefined) {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  // Trim seconds to 2 decimals (drop trailing zeros) so averages render as
  // "37.66s", not "37.66629547141797s". Whole values stay clean ("45s").
  const sec = Math.floor((s % 60) * 100) / 100;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
