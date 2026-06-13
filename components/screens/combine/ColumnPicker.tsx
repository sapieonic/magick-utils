"use client";
// Self-contained copy of the column picker used by the Combine screen.
// Ported from the design's screens-campaigns.jsx (ColumnPicker + relevantGroups).

import { Checkbox } from "@/components/ui";
import { COLUMN_GROUPS } from "@/lib/data";
import type { ColumnGroup } from "@/lib/types";

export function relevantGroups(st: string): ColumnGroup[] {
  return [COLUMN_GROUPS.common, COLUMN_GROUPS[st]].filter(Boolean) as ColumnGroup[];
}

export function ColumnPicker({
  groups,
  selected,
  setSelected,
}: {
  groups: ColumnGroup[];
  selected: Set<string>;
  setSelected: (updater: (prev: Set<string>) => Set<string>) => void;
}) {
  const allKeys = groups.flatMap((g) => g.columns.map((c) => c.key));
  const allChecked = allKeys.every((k) => selected.has(k));
  const toggleAll = () => setSelected(() => (allChecked ? new Set<string>() : new Set(allKeys)));
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-slate-500">
          <span className="font-bold text-slate-700">{selected.size}</span> of {allKeys.length} columns selected
        </div>
        <button onClick={toggleAll} className="text-[13px] font-semibold text-[var(--accent-strong)] hover:underline">
          {allChecked ? "Deselect all" : "Select all"}
        </button>
      </div>
      <div className="space-y-4">
        {groups.map((g) => {
          const groupKeys = g.columns.map((c) => c.key);
          const groupAll = groupKeys.every((k) => selected.has(k));
          return (
            <div key={g.label}>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{g.label}</div>
                <div className="h-px flex-1 bg-slate-100" />
                <button
                  onClick={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      groupAll ? groupKeys.forEach((k) => n.delete(k)) : groupKeys.forEach((k) => n.add(k));
                      return n;
                    })
                  }
                  className="text-[11px] font-semibold text-slate-400 hover:text-[var(--accent-strong)]"
                >
                  {groupAll ? "clear" : "all"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {g.columns.map((col) => (
                  <Checkbox
                    key={col.key}
                    checked={selected.has(col.key)}
                    onChange={() => toggle(col.key)}
                    label={<span className="font-mono text-[12.5px]">{col.label}</span>}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
