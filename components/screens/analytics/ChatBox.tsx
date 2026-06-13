"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, Icon } from "@/components/ui";
import { streamChat } from "@/lib/api";
import type { Batch } from "@/lib/types";
import { Num } from "./Num";

type Part = { t: string; num?: boolean; tone?: "good" | "bad" };

type ChatMessage =
  | { role: "user"; text: string }
  // `parts` drives the canned typewriter path; `text` drives the live-streamed
  // plain-text path. Exactly one is populated per assistant message.
  | { role: "assistant"; parts?: Part[]; text?: string; model: string; streaming: boolean };

const SUGGESTIONS = [
  "Why did this batch underperform?",
  "What is the best time to call?",
  "Summarize the negative conversations",
  "How can I cut cost without losing connect rate?",
];

const CANNED: { default: Part[] } = {
  default: [
    { t: "Two things held this batch back. " },
    { t: "First, " },
    { t: "no-answer rate", num: true, tone: "bad" },
    { t: " hit " },
    { t: "38%", num: true, tone: "bad" },
    { t: " on Day 4 (vs a " },
    { t: "61%", num: true },
    { t: " baseline) — a dialer throttle in the 3–5pm slot. Second, " },
    { t: "312 calls", num: true, tone: "bad" },
    { t: " were tagged “wrong amount”, 2.4× the usual share, dragging sentiment to " },
    { t: "19% negative", num: true, tone: "bad" },
    { t: ". Fixing the dunning sync and shifting dials to the " },
    { t: "11am–1pm", num: true, tone: "good" },
    { t: " window should recover most of the gap." },
  ],
};

export function ChatBox({ model, batchIds }: { model: string; targets: Batch[]; batchIds: string[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

  const ask = (q: string) => {
    if (!q.trim() || streaming) return;
    const userMsg: ChatMessage = { role: "user", text: q };
    // History from prior turns (before this question) for the live LLM call.
    const history = messages.map((msg) =>
      msg.role === "user"
        ? { role: "user" as const, content: msg.text }
        : { role: "assistant" as const, content: msg.text ?? (msg.parts ?? []).map((p) => p.t).join("") },
    );
    // Optimistically append the user turn + an empty assistant placeholder that
    // onDelta will fill in (live path). The placeholder index is the new length.
    const placeholderIdx = messages.length + 1;
    setMessages((m) => [...m, userMsg, { role: "assistant", text: "", model, streaming: true }]);
    setInput("");
    setStreaming(true);

    streamChat(batchIds, model, q, history, (delta) => {
      setMessages((m) => m.map((msg, i) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, text: (msg.text ?? "") + delta } : msg)));
    }).then((live) => {
      if (live) {
        // Live path done: mark the streamed message as settled.
        setStreaming(false);
        setMessages((m) => m.map((msg, i) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, streaming: false } : msg)));
      } else {
        // LLM off → replace the placeholder with the canned typewriter message.
        setMessages((m) => m.map((msg, i) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, text: undefined, parts: CANNED.default } : msg)));
      }
    }).catch(() => {
      // Network/stream error mid-flight: settle gracefully so input re-enables
      // instead of staying disabled forever.
      setStreaming(false);
      setMessages((m) =>
        m.map((msg, i) =>
          i === placeholderIdx && msg.role === "assistant"
            ? { ...msg, streaming: false, text: msg.text && msg.text.length ? msg.text : "Sorry — I couldn't reach the assistant. Please try again." }
            : msg,
        ),
      );
    });
  };

  const onStreamDone = () => {
    setStreaming(false);
    setMessages((m) => m.map((msg, i) => (i === m.length - 1 && msg.role === "assistant" ? { ...msg, streaming: false } : msg)));
  };

  return (
    <Card className="mt-5 overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-slate-100">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-white" style={{ background: "var(--brand-grad)" }}>
          <Icon name="MessageCircleQuestion" size={17} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-slate-900">Ask about this campaign</div>
          <div className="text-[11.5px] text-slate-400">Answers reference this campaign&apos;s data</div>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="ml-auto text-[12px] font-semibold text-slate-400 hover:text-slate-600 flex items-center gap-1">
            <Icon name="Eraser" size={13} /> Clear
          </button>
        )}
      </div>

      {messages.length > 0 && (
        <div ref={scrollRef} className="max-h-[340px] overflow-y-auto px-5 py-4 space-y-4 bg-slate-50/40">
          {messages.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13.5px] text-white font-medium" style={{ background: "var(--accent)" }}>
                  {msg.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-2.5">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white shrink-0 mt-0.5" style={{ background: "var(--brand-grad)" }}>
                  <Icon name="Sparkles" size={14} />
                </span>
                <div className="max-w-[82%] rounded-2xl rounded-tl-md bg-white border border-slate-200 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-slate-600">
                  {msg.parts ? (
                    msg.streaming ? (
                      <StreamParts parts={msg.parts} onDone={onStreamDone} />
                    ) : (
                      <RenderParts parts={msg.parts} />
                    )
                  ) : (
                    <span className="whitespace-pre-wrap">
                      {msg.text}
                      {msg.streaming && <span className="caret" />}
                    </span>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      <div className="p-3.5">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-600 hover:border-[var(--accent)] hover:text-[var(--accent-strong)] transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Icon name="Sparkles" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
              placeholder="Ask anything about this campaign…"
              className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
            />
          </div>
          <Button type="submit" size="lg" icon={streaming ? undefined : "ArrowUp"} loading={streaming} disabled={!input.trim()} className="!px-4">
            {streaming ? "" : "Send"}
          </Button>
        </form>
      </div>
    </Card>
  );
}

function RenderParts({ parts }: { parts: Part[] }) {
  return (
    <span>
      {parts.map((p, i) => (p.num ? <Num key={i} tone={p.tone}>{p.t}</Num> : <span key={i}>{p.t}</span>))}
    </span>
  );
}

export function StreamParts({ parts, onDone }: { parts: Part[]; onDone?: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= parts.length) {
      onDone && onDone();
      return;
    }
    const t = setTimeout(() => setN(n + 1), 90 + Math.random() * 110);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, parts.length]);
  const shown = parts.slice(0, n);
  return (
    <span>
      {shown.map((p, i) => (p.num ? <Num key={i} tone={p.tone}>{p.t}</Num> : <span key={i}>{p.t}</span>))}
      {n < parts.length && <span className="caret" />}
    </span>
  );
}
