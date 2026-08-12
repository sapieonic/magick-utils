"use client";

import { ChartCard } from "@/components/ui";
import { fmtNum, fmtPct } from "@/lib/data";
import type { IvrDropoff } from "@/lib/server/types";
import { FunnelBars } from "./FunnelBars";
import { RankedBars } from "./RankedBars";

export function IvrDropoffCard({ dropoff }: { dropoff: IvrDropoff | null }) {
  return (
    <ChartCard
      title="IVR drop-off"
      subtitle="Where IVR callers stopped · hang-up = completed node hangup / abandon / timeout"
    >
      {!dropoff ? (
        <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-slate-500">
          No IVR calls in this period.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">IVR hang-up rate</div>
              <div className="mt-0.5 text-[20px] font-extrabold tabnum tracking-tight text-slate-900">
                {fmtPct(dropoff.hangupRate)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {fmtNum(dropoff.hangupCount)} hang-ups of {fmtNum(dropoff.totalIvr)} IVR calls
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">Reached a 2nd node</div>
              <div className="mt-0.5 text-[20px] font-extrabold tabnum tracking-tight text-slate-900">
                {dropoff.withPath > 0
                  ? fmtPct((dropoff.depthFunnel.find((s) => s.stage === "2nd node")?.value ?? 0) / dropoff.withPath)
                  : "—"}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {fmtNum(dropoff.withPath)} journeys with a path
              </div>
            </div>
          </div>
          <FunnelBars data={dropoff.depthFunnel} />
          <div>
            <div className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Ended at</div>
            <RankedBars
              items={dropoff.completedNodes.map((n) => ({ label: n.label ?? n.key, value: n.value }))}
              empty="No completed-node or path endings recorded."
            />
          </div>
          {dropoff.topPaths.length > 0 && (
            <div>
              <div className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Top paths</div>
              <RankedBars items={dropoff.topPaths.map((p) => ({ label: p.path, value: p.value }))} />
            </div>
          )}
          {dropoff.dtmf.length > 0 && (
            <div>
              <div className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">DTMF</div>
              <div className="flex flex-wrap gap-1.5">
                {dropoff.dtmf.map((d) => (
                  <span
                    key={d.input}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[12px] font-semibold text-slate-700"
                  >
                    <span className="font-mono">{d.input}</span>
                    <span className="tabnum text-slate-400">{fmtNum(d.value)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}
