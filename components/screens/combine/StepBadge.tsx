"use client";

import { Icon, cx } from "@/components/ui";

export function StepBadge({ n, active, done }: { n?: number; active?: boolean; done?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold shrink-0 transition-colors",
        done ? "text-white" : active ? "text-white" : "bg-slate-100 text-slate-400",
      )}
      style={done || active ? { background: "var(--accent)" } : undefined}
    >
      {done ? <Icon name="Check" size={15} strokeWidth={3} /> : n}
    </span>
  );
}
