"use client";

import { EmptyState, SkeletonRow, Spinner } from "@/components/ui";

/** Stand-in for a chart that has nothing real to draw.
 *
 *  On a live backend the analytics tabs never substitute seeded demo numbers,
 *  so every chart needs two honest states — and the customer must be able to
 *  tell them apart: `loading` shimmers (the pull is still running), otherwise
 *  we say plainly that there is no data. */
export function ChartPlaceholder({
  loading = false,
  title,
  body,
  icon = "ChartColumnBig",
  height = 240,
  variant = "chart",
}: {
  loading?: boolean;
  title: string;
  body?: string;
  icon?: string;
  height?: number;
  variant?: "chart" | "rows";
}) {
  // One live region spanning both branches, so the outcome replaces the
  // loading state in place instead of the announcement stopping at "Loading…".
  // `role="status"` already implies aria-live="polite". The visible "Loading…"
  // is aria-hidden and the busy state carries it instead: Overview renders
  // three placeholders at once, and three simultaneous "Loading…" announcements
  // would say nothing aria-busy doesn't.
  return (
    <div
      role="status"
      aria-busy={loading}
      style={loading ? { height } : { minHeight: height }}
      className={loading ? "flex flex-col" : "flex items-center justify-center"}
    >
      {loading ? (
        <>
          {variant === "rows" ? (
            <div className="flex-1 overflow-hidden">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} cols={3} />
              ))}
            </div>
          ) : (
            <div className="flex flex-1 items-end gap-3">
              {[58, 84, 46, 96, 68, 78, 52].map((h, i) => (
                <div key={i} className="skeleton flex-1 rounded-lg" style={{ height: `${h}%` }} />
              ))}
            </div>
          )}
          <div aria-hidden className="mt-3 flex items-center justify-center gap-2 text-xs font-medium text-slate-400">
            <Spinner size={13} /> Loading…
          </div>
        </>
      ) : (
        <EmptyState icon={icon} title={title} body={body} />
      )}
    </div>
  );
}
