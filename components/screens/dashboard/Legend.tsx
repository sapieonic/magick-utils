"use client";

export function Legend({ items }: { items: { c: string; l: string }[] }) {
  return (
    <div className="flex items-center gap-3">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: it.c }} />
          {it.l}
        </span>
      ))}
    </div>
  );
}
