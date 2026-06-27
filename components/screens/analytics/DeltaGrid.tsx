"use client";

import { Card, Icon, cx } from "@/components/ui";
import { fmtMoney, fmtMoneyFull, fmtNum, fmtPct } from "@/lib/data";
import type { AggregatesDiff } from "@/lib/server/types";
import type { Currency } from "@/lib/types";

type Polarity = "higher" | "lower" | "neutral";
type Tone = "good" | "bad" | "neutral";

/** Resolve direction-aware tone: a falling cost is GOOD, a falling answer rate
 *  is BAD. Sign alone never decides color — polarity does. */
function tone(deltaSign: number, betterWhen: Polarity, flat: boolean): Tone {
  if (flat || betterWhen === "neutral") return "neutral";
  const rose = deltaSign > 0;
  return (betterWhen === "higher" ? rose : !rose) ? "good" : "bad";
}

const TONE_CLASS: Record<Tone, string> = {
  good: "text-emerald-700 bg-emerald-50",
  bad: "text-red-700 bg-red-50",
  neutral: "text-slate-600 bg-slate-100",
};

function DeltaTile({
  label,
  icon,
  value,
  deltaText,
  deltaSign,
  betterWhen,
  flat,
  title,
}: {
  label: string;
  icon: string;
  value: string;
  deltaText: string;
  deltaSign: number;
  betterWhen: Polarity;
  flat: boolean;
  title?: string;
}) {
  const t = tone(deltaSign, betterWhen, flat);
  const arrow = flat ? "Minus" : deltaSign > 0 ? "TrendingUp" : "TrendingDown";
  return (
    <Card className="p-4 fade-up">
      <div className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
          <Icon name={icon} size={15} />
        </span>
        {label}
      </div>
      <div className="mt-2.5 text-[24px] font-extrabold tracking-tight text-slate-900 tabnum leading-none">{value}</div>
      <div className="mt-2.5">
        <span className={cx("inline-flex items-center gap-0.5 text-xs font-semibold rounded-full px-1.5 py-0.5", TONE_CLASS[t])} title={title}>
          <Icon name={arrow} size={12} />
          {deltaText}
        </span>
      </div>
    </Card>
  );
}

/** Deterministic delta strip for Comparative Insights. Rendered from two
 *  AggregatesDocs diffed client-side, so the numbers are always present even
 *  when the LLM (narrative) is off. */
export function DeltaGrid({ diff, currency, isMessage, baselineLabel }: { diff: AggregatesDiff; currency: Currency; isMessage: boolean; baselineLabel: string }) {
  const FLAT_PP = 0.05; // success-rate points considered "no change"
  const FLAT_REL = 0.005; // 0.5% relative considered "no change"

  const ppText = (pp: number) => (Math.abs(pp) < FLAT_PP ? "no change" : `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(1)} pts`);
  const relText = (rel: number | null) => (rel == null ? "n/a" : Math.abs(rel) < FLAT_REL ? "no change" : `${rel > 0 ? "+" : "−"}${Math.abs(Math.round(rel * 100))}%`);

  const rate = diff.successRate;
  const spend = diff.spendInr;

  // Cost per record — efficiency, not just total spend.
  const cprCur = diff.current.totalRecords > 0 ? spend.current / diff.current.totalRecords : 0;
  const cprBase = diff.baseline.totalRecords > 0 ? spend.baseline / diff.baseline.totalRecords : 0;
  const cprRel = cprBase !== 0 ? (cprCur - cprBase) / cprBase : null;

  const vol = diff.volume;
  const volRel = vol.relative;

  return (
    <div>
      <div className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-2">
        <Icon name="GitCompareArrows" size={14} /> What changed vs {baselineLabel}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <DeltaTile
          label={isMessage ? "Read rate" : "Answer rate"}
          icon={isMessage ? "MailOpen" : "PhoneCall"}
          value={fmtPct(rate.current)}
          deltaText={ppText(rate.deltaPp)}
          deltaSign={rate.deltaPp}
          betterWhen="higher"
          flat={Math.abs(rate.deltaPp) < FLAT_PP}
          title={`${fmtPct(rate.current)} vs ${fmtPct(rate.baseline)}`}
        />
        <DeltaTile
          label="Total spend"
          icon="Wallet"
          value={fmtMoney(spend.current, currency)}
          deltaText={relText(spend.relative)}
          deltaSign={spend.delta}
          betterWhen="lower"
          flat={spend.relative != null && Math.abs(spend.relative) < FLAT_REL}
          title={`${fmtMoneyFull(spend.current, currency)} vs ${fmtMoneyFull(spend.baseline, currency)}`}
        />
        <DeltaTile
          label="Cost per record"
          icon="Coins"
          value={fmtMoneyFull(cprCur, currency)}
          deltaText={relText(cprRel)}
          deltaSign={cprCur - cprBase}
          betterWhen="lower"
          flat={cprRel != null && Math.abs(cprRel) < FLAT_REL}
          title={`${fmtMoneyFull(cprCur, currency)} vs ${fmtMoneyFull(cprBase, currency)} per record`}
        />
        <DeltaTile
          label="Records"
          icon="Users"
          value={fmtNum(vol.current)}
          deltaText={relText(volRel)}
          deltaSign={vol.delta}
          betterWhen="neutral"
          flat={volRel != null && Math.abs(volRel) < FLAT_REL}
          title={`${fmtNum(vol.current)} vs ${fmtNum(vol.baseline)} records`}
        />
      </div>
    </div>
  );
}
