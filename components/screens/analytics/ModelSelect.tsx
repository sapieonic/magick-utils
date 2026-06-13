"use client";

import { Dropdown, Icon, cx } from "@/components/ui";
import { MODELS } from "./models";

export function ModelSelect({ model, setModel, compact }: { model: string; setModel: (id: string) => void; compact?: boolean }) {
  const m = MODELS.find((x) => x.id === model)!;
  return (
    <Dropdown
      align="right"
      width={236}
      trigger={
        <button className="flex items-center gap-2 h-9 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
            <Icon name={m.icon} size={13} />
          </span>
          {!compact && <span>{m.name}</span>}
          <Icon name="ChevronDown" size={14} className="text-slate-400" />
        </button>
      }
    >
      {(close: () => void) => (
        <>
          <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">AI model</div>
          {MODELS.map((x) => (
            <button
              key={x.id}
              onClick={() => {
                setModel(x.id);
                close();
              }}
              className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors", x.id === model ? "bg-[var(--accent-soft)]" : "hover:bg-slate-100")}
            >
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg shrink-0" style={{ background: x.id === model ? "var(--accent)" : "#f1f5f9", color: x.id === model ? "#fff" : "#64748b" }}>
                <Icon name={x.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-slate-800">{x.name}</span>
                <span className="block text-[11px] text-slate-400">{x.tag}</span>
              </span>
              {x.id === model && <Icon name="Check" size={15} className="text-[var(--accent-strong)]" />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );
}
