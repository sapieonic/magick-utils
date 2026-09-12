"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Input,
  SkeletonRow,
  StatusStackBar,
  TypeBadge,
  TypeDot,
  cx,
} from "@/components/ui";
import {
  SEL_LABEL,
  STATUS,
  TYPES,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtPct,
  selType,
  typeKey,
} from "@/lib/data";
import { useApp } from "@/lib/store";
import { DASHBOARD_RANGES, isDashboardRange, type DashboardRange } from "@/lib/date-range";
import type { Batch, BreakdownSeg, SelType } from "@/lib/types";
import { listCampaigns } from "@/lib/api";
import { pageSlots } from "@/lib/pagination";
import { FilterSelect } from "@/components/screens/campaigns/FilterSelect";
import { DownloadModal } from "@/components/screens/campaigns/DownloadModal";

const PAGE_SIZE = 8;

/** The sentinel the date FilterSelect uses for "not filtering", so it renders
 *  neutral like the other "All …" options instead of permanently highlighted. */
const RANGE_ANY = "all";

type SortState = { key: string; dir: "asc" | "desc" };

/** Drop selected ids that are not in `batches`, keeping the original Set when
 *  nothing was dropped so an unchanged selection doesn't re-render the table. */
function retain(selected: Set<string>, batches: Batch[]): Set<string> {
  const ids = new Set(batches.map((b) => b.id));
  const kept = Array.from(selected).filter((id) => ids.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

function SortHead({
  k,
  children,
  align,
  sort,
  onSort,
}: {
  k: string;
  children: React.ReactNode;
  align?: "right";
  sort: SortState;
  onSort: (key: string) => void;
}) {
  return (
    <th className={cx("px-3 py-2.5 font-bold select-none", align === "right" && "text-right")}>
      <button
        onClick={() => onSort(k)}
        className={cx(
          "inline-flex items-center gap-1 hover:text-slate-700 transition-colors",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <Icon
          name={sort.key === k ? (sort.dir === "desc" ? "ChevronDown" : "ChevronUp") : "ChevronsUpDown"}
          size={13}
          className={sort.key === k ? "text-[var(--accent)]" : "text-slate-300"}
        />
      </button>
    </th>
  );
}

export default function CampaignsScreen() {
  const { currency, dateRange, setDateRange, setCombineTargets, setAnalyzeTargets } = useApp();
  const router = useRouter();
  // dateRange is hydrated from sessionStorage, so it can be any string. Coerce it
  // the way the dashboard does — a value we don't recognise must mean "no date
  // filter", never an error screen.
  const range: DashboardRange = isDashboardRange(dateRange) ? dateRange : "All time";
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [statusF, setStatusF] = useState("all");
  const [providerF, setProviderF] = useState("all");
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [downloadCampaign, setDownloadCampaign] = useState<Batch | null>(null);
  // Start empty — never seed with mock. listCampaigns() returns mock only when
  // the backend is off; on a live backend no mock rows ever render here.
  const [campaigns, setCampaigns] = useState<Batch[]>([]);
  // The range the rows on screen belong to. Anything else — including the
  // initial null — means the list is still catching up, so a range switch shows
  // the skeleton instead of stale rows (same idiom as the dashboard).
  const [loadedRange, setLoadedRange] = useState<DashboardRange | null>(null);
  const loading = loadedRange !== range;
  const [loadError, setLoadError] = useState<string | null>(null);
  // The backend stopped scanning upstream jobs at its cap, so this listing may be
  // missing campaigns it never looked at. Surfaced below — a listing that is
  // short for that reason must not read as "you have no campaigns".
  const [truncated, setTruncated] = useState(false);

  // load via the data seam — returns mock when the backend is off, live data when
  // on. The Topbar's date range is server-side filtering, so this refetches
  // whenever it changes; `active` drops a response that a faster switch has
  // already superseded.
  useEffect(() => {
    let active = true;
    listCampaigns(range)
      .then((r) => {
        if (active) {
          setCampaigns(r.batches);
          setTruncated(Boolean(r.truncated));
          setLoadError(null);
          // A new range is a new result set — paging back to the top keeps the
          // pager inside the filtered count, and rows that fell out of scope must
          // not stay selected: the bulk bar would otherwise count batches nobody
          // can see and lose the same-type label along with them.
          setPage(1);
          setSelected((s: Set<string>) => retain(s, r.batches));
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        // Never leave the previous range's rows on screen under a failed load —
        // nor a selection or a page number that belonged to them.
        setCampaigns([]);
        setTruncated(false);
        setPage(1);
        setSelected((s: Set<string>) => (s.size === 0 ? s : new Set()));
        setLoadError(error instanceof Error ? error.message : "Unable to load campaigns.");
      })
      .finally(() => {
        if (active) setLoadedRange(range);
      });
    return () => {
      active = false;
    };
  }, [range]);

  const providers = useMemo(() => ["all", ...Array.from(new Set(campaigns.map((c: Batch) => c.provider)))], [campaigns]);

  const filtered = useMemo(() => {
    const list = campaigns.filter((c: Batch) => {
      if (channel !== "all" && typeKey(c) !== channel) return false;
      if (providerF !== "all" && c.provider !== providerF) return false;
      if (statusF !== "all" && !c.breakdown.some((b: BreakdownSeg) => b.key === statusF)) return false;
      if (
        search &&
        !(
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.batchId.toLowerCase().includes(search.toLowerCase())
        )
      )
        return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    const val: Record<string, (c: Batch) => number> = {
      records: (c) => c.total,
      success: (c) => c.successRate,
      spend: (c) => c.spendInr,
      date: (c) => -c.dayAgo,
    };
    return [...list].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
      const f = val[sort.key] || val.date;
      return (f(a) - f(b)) * dir;
    });
  }, [search, channel, statusF, providerF, sort, campaigns]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // same-type selection: once a batch is picked, only batches of that selType can join
  const activeSelType = useMemo<SelType | null>(() => {
    for (const id of selected) {
      const c = campaigns.find((x: Batch) => x.id === id);
      if (c) return selType(c);
    }
    return null;
  }, [selected, campaigns]);
  const selectable = (c: Batch) => !activeSelType || selType(c) === activeSelType;

  const at = activeSelType || (pageItems[0] && selType(pageItems[0]));
  const eligible = pageItems.filter((c: Batch) => selType(c) === at);
  const allOnPageSelected = eligible.length > 0 && eligible.every((c: Batch) => selected.has(c.id));
  const someSelected = pageItems.some((c: Batch) => selected.has(c.id));

  const toggle = (id: string) =>
    setSelected((s: Set<string>) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const togglePage = () =>
    setSelected((s: Set<string>) => {
      const n = new Set(s);
      if (allOnPageSelected) eligible.forEach((c: Batch) => n.delete(c.id));
      else eligible.forEach((c: Batch) => n.add(c.id));
      return n;
    });

  const setSortKey = (key: string) =>
    setSort((s: SortState) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));
  // The date range is a filter like any other here: it narrows what the screen
  // lists, so it has to count towards "you have filters on" and be cleared with
  // them. Leaving it out made "Clear filters" a no-op against the one filter that
  // had actually emptied the list.
  const resetFilters = () => {
    setSearch("");
    setChannel("all");
    setStatusF("all");
    setProviderF("all");
    setDateRange("All time");
    setPage(1);
  };
  const hasFilters =
    Boolean(search) || channel !== "all" || statusF !== "all" || providerF !== "all" || range !== "All time";

  const analyze = (ids: string[]) => {
    setAnalyzeTargets(ids);
    router.push("/analytics");
  };
  const combine = (ids: string[]) => {
    setCombineTargets(ids);
    router.push("/combine");
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6 pb-28">
      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 mb-4">
        <Input
          icon="Search"
          placeholder="Search campaigns or batch ID…"
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-full sm:w-72"
        />
        <FilterSelect
          icon="Filter"
          label="Type"
          value={channel}
          onChange={(value) => {
            setChannel(value);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All types" },
            ...Object.values(TYPES).map((t) => ({
              value: t.key,
              label: t.label + (t.key === "ai" || t.key === "ivr" ? "s" : ""),
            })),
          ]}
        />
        <FilterSelect
          icon="Activity"
          label="Status"
          value={statusF}
          onChange={(value) => {
            setStatusF(value);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All statuses" },
            ...Object.entries(STATUS).map(([k, v]) => ({ value: k, label: v.label })),
          ]}
        />
        <FilterSelect
          icon="Server"
          label="Provider"
          value={providerF}
          onChange={(value) => {
            setProviderF(value);
            setPage(1);
          }}
          options={providers.map((p: string) => ({ value: p, label: p === "all" ? "All providers" : p }))}
        />
        <FilterSelect
          icon="Calendar"
          label="Date range"
          value={range === "All time" ? RANGE_ANY : range}
          onChange={(value) => {
            // Shared with the Topbar control: one range, one place to undo it.
            setDateRange(value === RANGE_ANY ? "All time" : value);
            setPage(1);
          }}
          options={DASHBOARD_RANGES.map((r) => ({ value: r === "All time" ? RANGE_ANY : r, label: r }))}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon="X" onClick={resetFilters}>
            Clear
          </Button>
        )}
        <div className="ml-auto text-sm text-slate-400 hidden sm:block">
          {loading ? (
            "Loading…"
          ) : (
            <>
              <span className="font-semibold text-slate-600">{filtered.length}</span> batches
            </>
          )}
        </div>
      </div>

      {!loading && truncated && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-700">
          <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0" />
          <span>
            This account has more campaigns than one listing can scan, so some of them — including older
            ones — may be missing from this list. Counts and filters below apply only to what was scanned.
          </span>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-slate-500">
        <Icon name="ChartColumnBig" size={14} className="text-[var(--accent)]" />
        Select two or more checkboxes to analyze batches together. Combined selections must use the same batch type.
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[940px]">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50 sticky top-0 z-10">
                <th className="pl-5 pr-2 py-2.5 w-10">
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={someSelected && !allOnPageSelected}
                    onChange={togglePage}
                    ariaLabel="Select all eligible campaigns on this page"
                  />
                </th>
                <SortHead k="name" sort={sort} onSort={setSortKey}>Campaign</SortHead>
                <th className="px-3 py-2.5 font-bold">Type</th>
                <SortHead k="date" sort={sort} onSort={setSortKey}>Date</SortHead>
                <SortHead k="records" align="right" sort={sort} onSort={setSortKey}>
                  Records
                </SortHead>
                <th className="px-3 py-2.5 font-bold">Status breakdown</th>
                <SortHead k="success" align="right" sort={sort} onSort={setSortKey}>
                  Success
                </SortHead>
                <SortHead k="spend" align="right" sort={sort} onSort={setSortKey}>
                  Spend
                </SortHead>
                <th className="px-5 py-2.5 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: PAGE_SIZE }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={9}>
                        <SkeletonRow cols={8} />
                      </td>
                    </tr>
                  ))
                : pageItems.map((c: Batch) => {
                const isSel = selected.has(c.id);
                const canSel = selectable(c);
                return (
                  <tr
                    key={c.id}
                    className={cx(
                      "border-b border-slate-50 transition-colors group",
                      isSel ? "bg-[var(--accent-soft)]" : !canSel ? "opacity-55" : "hover:bg-slate-50/70"
                    )}
                  >
                    <td className="pl-5 pr-2 py-3">
                      <Checkbox
                        checked={isSel}
                        disabled={!canSel}
                        ariaLabel={`Select ${c.name}`}
                        title={
                          !canSel && activeSelType
                            ? `Combined analysis and CSV export require the same batch type (${SEL_LABEL[activeSelType as SelType]}). Clear the selection to switch types.`
                            : undefined
                        }
                        onChange={() => toggle(c.id)}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <TypeDot tkey={typeKey(c)} />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 truncate">{c.name}</div>
                          <div className="text-[11px] font-mono text-slate-400">
                            {c.batchId} · {c.provider}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <TypeBadge tkey={typeKey(c)} size="sm" />
                    </td>
                    <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{fmtDate(c.date)}</td>
                    <td className="px-3 py-3 text-right tabnum font-semibold text-slate-700">{fmtNum(c.total)}</td>
                    <td className="px-3 py-3">
                      <StatusStackBar breakdown={c.breakdown} />
                    </td>
                    <td className="px-3 py-3 text-right tabnum font-semibold text-slate-700">{fmtPct(c.successRate)}</td>
                    <td className="px-3 py-3 text-right tabnum font-semibold text-slate-700">
                      {fmtMoney(c.spendInr, currency)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="secondary" size="sm" icon="Download" onClick={() => setDownloadCampaign(c)}>
                          CSV
                        </Button>
                        <Button variant="ghost" size="sm" icon="ChartColumnBig" onClick={() => analyze([c.id])}>
                          Analyze
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Three genuinely different empty lists: a failed load, a list the
            filters (the date range included) emptied, and an account with
            nothing to show. Blaming filters that aren't set — or offering a
            "Clear filters" button that leaves the range in place — sent people
            looking for data that was never hidden by what they could see. */}
        {!loading && filtered.length === 0 && (
          loadError ? (
            <EmptyState
              icon="TriangleAlert"
              title="Campaigns are unavailable"
              body={loadError}
              action={
                <Button variant="secondary" icon="RotateCcw" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              }
            />
          ) : hasFilters ? (
            <EmptyState
              icon="SearchX"
              title="No campaigns match your filters"
              body={
                range === "All time"
                  ? "Try adjusting your search or clearing filters to see more results."
                  : `Only campaigns from ${range.toLowerCase()} are listed. Clear filters to go back to every campaign.`
              }
              action={
                <Button variant="secondary" icon="X" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon="Inbox"
              title="No campaigns yet"
              body={
                truncated
                  ? "Nothing turned up in the part of your history this listing was able to scan."
                  : "Campaigns appear here once a bulk job has run in this account."
              }
            />
          )
        )}

        {/* pagination */}
        {!loading && filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 border-t border-slate-100">
            <div className="text-[13px] text-slate-400">
              Showing{" "}
              <span className="font-semibold text-slate-600">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)}
              </span>{" "}
              of {filtered.length}
            </div>
            <div className="flex items-center gap-1.5">
              <IconButton
                icon="ChevronLeft"
                size="sm"
                aria-label="Previous page"
                disabled={page === 1}
                onClick={() => setPage((p: number) => Math.max(1, p - 1))}
                className={page === 1 ? "opacity-40 pointer-events-none" : ""}
              />
              {pageSlots(page, pages).map((slot, i) =>
                slot === "gap" ? (
                  <span
                    key={`gap-${i}`}
                    aria-hidden
                    className="h-8 min-w-6 px-1 inline-flex items-end justify-center text-[13px] font-semibold text-slate-300"
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={slot}
                    onClick={() => setPage(slot)}
                    aria-label={`Page ${slot}`}
                    aria-current={page === slot ? "page" : undefined}
                    className={cx(
                      "h-8 min-w-8 px-2 rounded-lg text-[13px] font-semibold transition-colors",
                      page === slot ? "text-white" : "text-slate-500 hover:bg-slate-100"
                    )}
                    style={page === slot ? { background: "var(--accent)" } : undefined}
                  >
                    {slot}
                  </button>
                ),
              )}
              <IconButton
                icon="ChevronRight"
                size="sm"
                aria-label="Next page"
                disabled={page === pages}
                onClick={() => setPage((p: number) => Math.min(pages, p + 1))}
                className={page === pages ? "opacity-40 pointer-events-none" : ""}
              />
            </div>
          </div>
        )}
      </Card>

      {/* bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 lg:pl-[124px] px-4 w-full max-w-2xl fade-up">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-900 text-white px-3 py-2.5 shadow-2xl">
            <span
              className="inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-lg text-white text-sm font-bold"
              style={{ background: "var(--accent)" }}
            >
              {selected.size}
            </span>
            <span className="text-sm font-medium text-slate-200 whitespace-nowrap">
              {[activeSelType ? SEL_LABEL[activeSelType as SelType] : null, selected.size > 1 ? "batches" : "batch"]
                .filter(Boolean)
                .join(" ")}
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-300 hover:bg-white/10 hover:text-white"
              icon="ChartColumnBig"
              onClick={() => analyze(Array.from(selected))}
            >
              {selected.size > 1 ? `Analyze ${selected.size} together` : "Analyze selected"}
            </Button>
            <Button size="sm" className="!text-white" icon="GitMerge" onClick={() => combine(Array.from(selected))}>
              Combine into one CSV
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              aria-label="Clear campaign selection"
              className="text-slate-400 hover:text-white hover:bg-white/10 rounded-lg p-1.5 ml-0.5"
            >
              <Icon name="X" size={16} />
            </button>
          </div>
        </div>
      )}

      {downloadCampaign && (
        <DownloadModal campaign={downloadCampaign} onClose={() => setDownloadCampaign(null)} />
      )}
    </div>
  );
}
