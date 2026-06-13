"use client";
import { Avatar, Dropdown, Icon, MenuItem, Segmented } from "@/components/ui";
import type { SessionUserInfo } from "@/lib/api";
import type { Currency, Workspace } from "@/lib/types";

const RANGES = ["Last 7 days", "Last 30 days", "Last 90 days", "This quarter", "All time"];

export function Topbar({
  title,
  workspace,
  user,
  currency,
  setCurrency,
  dateRange,
  setDateRange,
  setCollapsed,
  setMobileOpen,
  onSwitch,
  onSignout,
  right,
}: {
  title: string;
  workspace: Workspace;
  user?: SessionUserInfo | null;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  dateRange: string;
  setDateRange: (r: string) => void;
  setCollapsed: (fn: (c: boolean) => boolean) => void;
  setMobileOpen: (v: boolean) => void;
  onSwitch: () => void;
  onSignout: () => void;
  right?: React.ReactNode;
}) {
  // Real signed-in identity; fall back to a neutral label on the mock/no-backend
  // path where no session user exists.
  const displayName = user?.name || user?.email || "Account";
  const subtitle = [user?.email, workspace.role].filter(Boolean).join(" · ");
  return (
    <header className="sticky top-0 z-30 h-16 shrink-0 bg-white/85 backdrop-blur-md border-b border-slate-200 flex items-center gap-3 px-4 sm:px-6">
      <button className="lg:hidden text-slate-500 hover:text-slate-800 -ml-1 p-1.5" onClick={() => setMobileOpen(true)}>
        <Icon name="Menu" size={20} />
      </button>
      <button className="hidden lg:flex text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5" onClick={() => setCollapsed((c) => !c)}>
        <Icon name="PanelLeft" size={18} />
      </button>

      <div className="min-w-0">
        <h1 className="text-[17px] font-extrabold tracking-tight text-slate-900 truncate">{title}</h1>
      </div>

      <button onClick={onSwitch} className="hidden md:flex items-center gap-2 rounded-full border border-slate-200 bg-white pl-1.5 pr-3 py-1 hover:border-slate-300 hover:bg-slate-50 transition-colors ml-1 group">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-white text-[10px] font-bold" style={{ background: "var(--brand-grad)" }}>
          {workspace.name[0]}
        </span>
        <span className="text-[13px] font-semibold text-slate-700">{workspace.name}</span>
        <span className="text-[11px] font-mono text-slate-400">{workspace.tenant}</span>
        <Icon name="ChevronsUpDown" size={13} className="text-slate-300 group-hover:text-slate-500" />
      </button>

      <div className="flex-1" />

      {right}

      <Dropdown
        align="right"
        width={190}
        trigger={
          <button className="hidden sm:flex items-center gap-2 h-9 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors">
            <Icon name="Calendar" size={15} className="text-slate-400" />
            {dateRange}
            <Icon name="ChevronDown" size={14} className="text-slate-400" />
          </button>
        }
      >
        {(close) =>
          RANGES.map((r) => (
            <MenuItem
              key={r}
              icon={r === dateRange ? "Check" : undefined}
              onClick={() => {
                setDateRange(r);
                close();
              }}
            >
              {r}
            </MenuItem>
          ))
        }
      </Dropdown>

      <Segmented size="sm" value={currency} onChange={(v) => setCurrency(v as Currency)} options={[{ value: "inr", label: "₹ INR" }, { value: "usd", label: "$ USD" }]} />

      <Dropdown
        align="right"
        width={220}
        trigger={
          <button className="flex items-center gap-1.5 rounded-full hover:bg-slate-100 p-0.5 pr-1 transition-colors">
            <Avatar name={displayName} size={34} />
            <Icon name="ChevronDown" size={14} className="text-slate-400 hidden sm:block" />
          </button>
        }
      >
        {(close) => (
          <>
            <div className="px-2.5 py-2 mb-1 border-b border-slate-100">
              <div className="text-sm font-bold text-slate-800 truncate">{displayName}</div>
              {subtitle && <div className="text-xs text-slate-400 truncate">{subtitle}</div>}
            </div>
            <MenuItem icon="User" disabled shortcut="Soon" title="Coming soon">
              Profile
            </MenuItem>
            <MenuItem icon="Settings" disabled shortcut="Soon" title="Coming soon">
              Settings
            </MenuItem>
            <MenuItem
              icon="ArrowLeftRight"
              onClick={() => {
                close();
                onSwitch();
              }}
            >
              Switch workspace
            </MenuItem>
            <div className="my-1 h-px bg-slate-100" />
            <MenuItem
              icon="LogOut"
              danger
              onClick={() => {
                close();
                onSignout();
              }}
            >
              Sign out
            </MenuItem>
          </>
        )}
      </Dropdown>
    </header>
  );
}
