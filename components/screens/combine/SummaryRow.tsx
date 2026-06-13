"use client";

import type { ReactNode } from "react";

export function SummaryRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-bold text-slate-800 tabnum">{value}</dd>
    </div>
  );
}
