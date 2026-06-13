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
import type { Batch, BreakdownSeg, SelType } from "@/lib/types";
import { listCampaigns } from "@/lib/api";
import { FilterSelect } from "@/components/screens/campaigns/FilterSelect";
import { DownloadModal } from "@/components/screens/campaigns/DownloadModal";

const PAGE_SIZE = 8;

type SortState = { key: string; dir: "asc" | "desc" };

export default function CampaignsScreen() {
  const { currency, setCombineTargets, setAnalyzeTargets } = useApp();
  const router = useRouter();
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
  const [loading, setLoading] = useState(true);

  // load via the data seam — returns mock when the backend is off, live data when on
  useEffect(() => {
    let active = true;
    setLoading(true);
    listCampaigns()
      .then((r) => {
        if (active) setCampaigns(r.batches);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, channel, statusF, providerF]);

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
  const activeSelType = useMemo(() => {
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
  const SortHead = ({ k, children, align }: { k: string; children: React.ReactNode; align?: "right" }) => (
    <th className={cx("px-3 py-2.5 font-bold select-none", align === "right" && "text-right")}>
      <button
        onClick={() => setSortKey(k)}
        className={cx(
          "inline-flex items-center gap-1 hover:text-slate-700 transition-colors",
          align === "right" && "flex-row-reverse"
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

  const resetFilters = () => {
    setSearch("");
    setChannel("all");
    setStatusF("all");
    setProviderF("all");
  };
  const hasFilters = search || channel !== "all" || statusF !== "all" || providerF !== "all";

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
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          className="w-full sm:w-72"
        />
        <FilterSelect
          icon="Filter"
          label="Type"
          value={channel}
          onChange={setChannel}
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
          onChange={setStatusF}
          options={[
            { value: "all", label: "All statuses" },
            ...Object.entries(STATUS).map(([k, v]) => ({ value: k, label: v.label })),
          ]}
        />
        <FilterSelect
          icon="Server"
          label="Provider"
          value={providerF}
          onChange={setProviderF}
          options={providers.map((p: string) => ({ value: p, label: p === "all" ? "All providers" : p }))}
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
                  />
                </th>
                <SortHead k="name">Campaign</SortHead>
                <th className="px-3 py-2.5 font-bold">Type</th>
                <SortHead k="date">Date</SortHead>
                <SortHead k="records" align="right">
                  Records
                </SortHead>
                <th className="px-3 py-2.5 font-bold">Status breakdown</th>
                <SortHead k="success" align="right">
                  Success
                </SortHead>
                <SortHead k="spend" align="right">
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
                        title={
                          !canSel && activeSelType
                            ? `You can only combine batches of the same type (${SEL_LABEL[activeSelType as SelType]}). Clear the selection to switch types.`
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

        {!loading && filtered.length === 0 && (
          <EmptyState
            icon="SearchX"
            title="No campaigns match your filters"
            body="Try adjusting your search or clearing filters to see more results."
            action={
              <Button variant="secondary" icon="X" onClick={resetFilters}>
                Clear filters
              </Button>
            }
          />
        )}

        {/* pagination */}
        {!loading && filtered.length > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100">
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
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className={page === 1 ? "opacity-40 pointer-events-none" : ""}
              />
              {Array.from({ length: pages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i + 1)}
                  className={cx(
                    "h-8 min-w-8 px-2 rounded-lg text-[13px] font-semibold transition-colors",
                    page === i + 1 ? "text-white" : "text-slate-500 hover:bg-slate-100"
                  )}
                  style={page === i + 1 ? { background: "var(--accent)" } : undefined}
                >
                  {i + 1}
                </button>
              ))}
              <IconButton
                icon="ChevronRight"
                size="sm"
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
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
              {activeSelType ? SEL_LABEL[activeSelType] : ""}
              {selected.size > 1 ? " batches" : " batch"}
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-300 hover:bg-white/10 hover:text-white"
              icon="ChartColumnBig"
              onClick={() => analyze(Array.from(selected))}
            >
              Analyze together
            </Button>
            <Button size="sm" className="!text-white" icon="GitMerge" onClick={() => combine(Array.from(selected))}>
              Combine into one CSV
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-slate-400 hover:text-white hover:bg-white/10 rounded-lg p-1.5 ml-0.5"
            >
              <Icon name="X" size={16} />
            </button>
          </div>
        </div>
      )}

      {downloadCampaign && (
        <DownloadModal campaign={downloadCampaign} currency={currency} onClose={() => setDownloadCampaign(null)} />
      )}
    </div>
  );
}
