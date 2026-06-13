"use client";

import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export function Num({ children, tone }: { children: ReactNode; tone?: "good" | "bad" }) {
  const c = tone === "good" ? "text-emerald-700 bg-emerald-50" : tone === "bad" ? "text-red-700 bg-red-50" : "text-[var(--accent-strong)]";
  const bg = tone ? "" : "bg-[var(--accent-soft)]";
  return <span className={cx("font-bold rounded px-1 py-0.5 tabnum", c, bg)}>{children}</span>;
}
