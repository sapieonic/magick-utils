"use client";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { Icon, cx } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { useBrand } from "@/components/brand/BrandProvider";
import type { Workspace } from "@/lib/types";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" },
  { href: "/campaigns", label: "Campaigns", icon: "Table2" },
  { href: "/combine", label: "Combine CSV", icon: "GitMerge" },
  { href: "/analytics", label: "Analytics", icon: "ChartColumnBig" },
];

export function Sidebar({
  workspace,
  onSwitch,
  collapsed,
  mobileOpen,
  setMobileOpen,
}: {
  workspace: Workspace;
  onSwitch: () => void;
  collapsed: boolean;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const brand = useBrand();

  const item = (n: (typeof NAV)[number]) => {
    const active = pathname === n.href;
    return (
      <button
        key={n.href}
        onClick={() => {
          router.push(n.href);
          setMobileOpen(false);
        }}
        className={cx(
          "group relative flex items-center rounded-xl text-sm font-semibold transition-all w-full",
          collapsed ? "justify-center h-11" : "gap-3 px-3 h-10",
          active ? "text-[var(--accent-strong)]" : "text-slate-500 hover:text-slate-900 hover:bg-slate-100",
        )}
        style={active ? { background: "var(--accent-soft)" } : undefined}
        title={collapsed ? n.label : undefined}
      >
        {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full" style={{ background: "var(--accent)" }} />}
        <Icon name={n.icon} size={19} strokeWidth={active ? 2.4 : 2} />
        {!collapsed && <span>{n.label}</span>}
      </button>
    );
  };

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <aside
        className={cx(
          "z-50 flex flex-col bg-white border-r border-slate-200 shrink-0 transition-all duration-200",
          collapsed ? "w-[76px]" : "w-[248px]",
          "fixed inset-y-0 left-0 lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className={cx("h-16 flex items-center border-b border-slate-100 shrink-0", collapsed ? "justify-center px-2" : "px-5")}>
          {collapsed ? <Image src="/logo" alt={brand.name} width={34} height={34} unoptimized style={{ objectFit: "contain" }} /> : <Logo size={36} />}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {!collapsed && <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Workspace</div>}
          {NAV.map(item)}
        </nav>

        <div className="border-t border-slate-100 p-3">
          {!collapsed ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white text-xs font-bold shrink-0" style={{ background: "var(--brand-grad)" }}>
                  {workspace.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-slate-800 truncate">{workspace.name}</div>
                  <div className="text-[10.5px] font-mono text-slate-400 truncate">
                    {workspace.tenant}/{workspace.account}
                  </div>
                </div>
              </div>
              <button onClick={onSwitch} className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-white border border-slate-200 py-1.5 text-[12.5px] font-semibold text-slate-600 hover:text-[var(--accent-strong)] hover:border-slate-300 transition-colors">
                <Icon name="ArrowLeftRight" size={13} /> Switch workspace
              </button>
            </div>
          ) : (
            <button onClick={onSwitch} title="Switch workspace" className="flex w-full justify-center py-2 text-slate-400 hover:text-slate-700">
              <Icon name="ArrowLeftRight" size={18} />
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
