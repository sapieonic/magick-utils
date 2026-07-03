"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, Icon, cx } from "@/components/ui";
import { streamChat } from "@/lib/api";
import type { Batch } from "@/lib/types";
import { Num } from "./Num";

type Part = { t: string; num?: boolean; tone?: "good" | "bad" };

type ChatMessage =
  | { role: "user"; text: string }
  // `parts` drives the canned typewriter path; `text` drives the live-streamed
  // plain-text path. Exactly one is populated per assistant message.
  | { role: "assistant"; parts?: Part[]; text?: string; streaming: boolean };

const SUGGESTIONS = [
  { icon: "TrendingDown", text: "Why did this batch underperform?" },
  { icon: "Clock", text: "What is the best time to call?" },
  { icon: "MessageSquareWarning", text: "Summarize the negative conversations" },
  { icon: "Wallet", text: "How can I cut cost without losing connect rate?" },
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

export function ChatPanel({
  targets,
  batchIds,
  open,
  onClose,
}: {
  targets: Batch[];
  batchIds: string[];
  open: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const scope = targets.length === 1 ? targets[0].name : `${targets.length} campaigns`;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

  // Esc-to-close + focus the composer when the panel opens.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 220);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !streaming) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, streaming]);

  const ask = (q: string) => {
    if (!q.trim() || streaming) return;
    const userMsg: ChatMessage = { role: "user", text: q };
    // History from prior turns (before this question) for the live LLM call.
    const history = messages.map((msg: ChatMessage) =>
      msg.role === "user"
        ? { role: "user" as const, content: msg.text }
        : { role: "assistant" as const, content: msg.text ?? (msg.parts ?? []).map((p: Part) => p.t).join("") },
    );
    // Optimistically append the user turn + an empty assistant placeholder that
    // onDelta will fill in (live path). The placeholder index is the new length.
    const placeholderIdx = messages.length + 1;
    setMessages((m: ChatMessage[]) => [...m, userMsg, { role: "assistant", text: "", streaming: true }]);
    setInput("");
    setStreaming(true);

    streamChat(batchIds, q, history, (delta) => {
      setMessages((m: ChatMessage[]) => m.map((msg: ChatMessage, i: number) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, text: (msg.text ?? "") + delta } : msg)));
    })
      .then((live) => {
        if (live) {
          // Live path done: mark the streamed message as settled.
          setStreaming(false);
          setMessages((m: ChatMessage[]) => m.map((msg: ChatMessage, i: number) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, streaming: false } : msg)));
        } else {
          // LLM off → replace the placeholder with the canned typewriter message.
          setMessages((m: ChatMessage[]) => m.map((msg: ChatMessage, i: number) => (i === placeholderIdx && msg.role === "assistant" ? { ...msg, text: undefined, parts: CANNED.default } : msg)));
        }
      })
      .catch(() => {
        // Network/stream error mid-flight: settle gracefully so input re-enables
        // instead of staying disabled forever.
        setStreaming(false);
        setMessages((m: ChatMessage[]) =>
          m.map((msg: ChatMessage, i: number) =>
            i === placeholderIdx && msg.role === "assistant"
              ? { ...msg, streaming: false, text: msg.text && msg.text.length ? msg.text : "Sorry — I couldn't reach the assistant. Please try again." }
              : msg,
          ),
        );
      });
  };

  const onStreamDone = () => {
    setStreaming(false);
    setMessages((m: ChatMessage[]) => m.map((msg: ChatMessage, i: number) => (i === m.length - 1 && msg.role === "assistant" ? { ...msg, streaming: false } : msg)));
  };

  return (
    <>
      {/* Drawer backdrop — only below xl, where the panel overlays content. On xl+
          the panel docks beside the content (which reflows) so no backdrop. */}
      <div
        className={cx(
          "fixed inset-0 top-16 z-40 bg-slate-900/30 backdrop-blur-[1px] transition-opacity duration-200 xl:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        aria-label="Campaign assistant"
        className={cx(
          "fixed top-16 bottom-0 right-0 z-40 flex w-full flex-col border-l border-slate-200 bg-white shadow-[-12px_0_40px_-24px_rgba(15,23,42,0.35)] transition-transform duration-300 ease-out sm:w-[400px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* header */}
        <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3.5 shrink-0">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-white shrink-0" style={{ background: "var(--brand-grad)" }}>
            <Icon name="Sparkles" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-slate-900 leading-tight">Campaign Assistant</div>
            <div className="text-[11.5px] text-slate-400 truncate flex items-center gap-1">
              <Icon name="Database" size={11} className="shrink-0" />
              Grounded on <span className="font-semibold text-slate-500">{scope}</span>
            </div>
          </div>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              disabled={streaming}
              className="text-[12px] font-semibold text-slate-400 hover:text-slate-600 disabled:opacity-40 flex items-center gap-1"
              title="Clear conversation"
            >
              <Icon name="Eraser" size={13} /> Clear
            </button>
          )}
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors" title="Close (Esc)">
            <Icon name="X" size={18} />
          </button>
        </div>

        {/* messages / empty state */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 bg-slate-50/40">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2 text-[13.5px] font-bold text-slate-800">
                  <Icon name="Sparkles" size={15} className="text-[var(--accent-strong)]" />
                  Ask about this campaign
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
                  Answers reference the ingested data for <span className="font-semibold text-slate-500">{scope}</span>. Try a starter below or type your own question.
                </p>
              </div>
              <div className="mt-3 space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => ask(s.text)}
                    className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-[13px] font-medium text-slate-600 transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-strong)]"
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400 transition-colors group-hover:bg-[var(--accent-soft)] group-hover:text-[var(--accent-strong)]">
                      <Icon name={s.icon} size={14} />
                    </span>
                    <span className="flex-1">{s.text}</span>
                    <Icon name="ArrowUpRight" size={14} className="text-slate-300 group-hover:text-[var(--accent)]" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg: ChatMessage, i: number) =>
                msg.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13.5px] font-medium text-white" style={{ background: "var(--accent)" }}>
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex gap-2.5">
                    <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: "var(--brand-grad)" }}>
                      <Icon name="Sparkles" size={14} />
                    </span>
                    <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed text-slate-600">
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
        </div>

        {/* composer */}
        <div className="border-t border-slate-100 p-3 shrink-0">
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              ask(input);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Icon name="Sparkles" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
              <input
                ref={inputRef}
                value={input}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
                disabled={streaming}
                placeholder="Ask anything about this campaign…"
                className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
              />
            </div>
            <Button type="submit" size="lg" icon={streaming ? undefined : "ArrowUp"} loading={streaming} disabled={!input.trim()} className="!w-11 !px-0" title="Send" />
          </form>
          <div className="mt-2 px-1 text-[11px] text-slate-400">Answers are AI-generated from this campaign&apos;s data.</div>
        </div>
      </aside>
    </>
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
