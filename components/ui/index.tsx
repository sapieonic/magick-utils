"use client";
// Shared UI primitives — ported from the handoff components.jsx.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
} from "recharts";
import { CHANNELS, STATUS, TYPES, fmtNum } from "@/lib/data";
import type { BreakdownSeg, Channel, StatusKey, TypeKey } from "@/lib/types";
import { Icon, cx } from "./icon";

export { Icon, cx };

// ---------- Card ----------
export function Card({
  className,
  children,
  padded = false,
  ...rest
}: { className?: string; children?: ReactNode; padded?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.10)]",
        padded && "p-5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

// ---------- Spinner ----------
export function Spinner({ size = 16, light }: { size?: number; light?: boolean }) {
  return (
    <span
      className="inline-block animate-spin rounded-full align-[-2px]"
      style={{
        width: size,
        height: size,
        border: `2px solid ${light ? "rgba(255,255,255,0.4)" : "rgba(100,116,139,0.25)"}`,
        borderTopColor: light ? "#fff" : "var(--accent)",
      }}
    />
  );
}

// ---------- Button ----------
type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "soft" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "primary", size = "md", icon, iconRight, children, className, disabled, loading, ...rest }: ButtonProps) {
  const sizes = {
    sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
    md: "h-9.5 px-3.5 text-sm gap-2 rounded-xl",
    lg: "h-11 px-5 text-[15px] gap-2 rounded-xl",
  };
  const variants = {
    primary: "text-white shadow-sm hover:brightness-[1.06] active:brightness-95",
    secondary: "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-sm",
    ghost: "text-slate-600 hover:bg-slate-100",
    soft: "text-[var(--accent-strong)] hover:brightness-95",
    danger: "bg-white text-red-600 border border-red-200 hover:bg-red-50",
  };
  const style: CSSProperties | undefined =
    variant === "primary" ? { background: "var(--accent)" } : variant === "soft" ? { background: "var(--accent-soft)" } : undefined;
  return (
    <button
      style={{ height: size === "md" ? 38 : undefined, ...style }}
      className={cx(
        "inline-flex items-center justify-center font-semibold transition-all whitespace-nowrap select-none disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        sizes[size],
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 13 : 15} light={variant === "primary"} /> : icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={size === "sm" ? 15 : 17} />}
    </button>
  );
}

export function IconButton({ icon, size = "md", active, className, ...rest }: { icon: string; size?: "sm" | "md"; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      style={{ height: size === "sm" ? 32 : 38, width: size === "sm" ? 32 : 38 }}
      className={cx(
        "inline-flex items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 18} />
    </button>
  );
}

// ---------- Badges ----------
export function Badge({ children, color = "#64748b", soft = "#f1f5f9", text, dot, className }: { children?: ReactNode; color?: string; soft?: string; text?: string; dot?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold leading-5", className)} style={{ background: soft, color: text || color }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

export function ChannelBadge({ channel, size = "md" }: { channel: Channel; size?: "sm" | "md" }) {
  const c = CHANNELS[channel];
  if (!c) return null;
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full font-semibold", size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs")} style={{ background: c.soft, color: c.text }}>
      <Icon name={c.icon} size={size === "sm" ? 12 : 13} />
      {c.label}
    </span>
  );
}

export function ChannelDot({ channel, size = 28 }: { channel: Channel; size?: number }) {
  const c = CHANNELS[channel];
  return (
    <span className="inline-flex items-center justify-center rounded-lg shrink-0" style={{ width: size, height: size, background: c.soft, color: c.text }}>
      <Icon name={c.icon} size={size * 0.5} />
    </span>
  );
}

export function StatusBadge({ status }: { status: StatusKey }) {
  const s = STATUS[status];
  if (!s) return null;
  return (
    <Badge color={s.color} soft={s.soft} text={s.text} dot>
      {s.label}
    </Badge>
  );
}

export function TypeBadge({ tkey, size = "md" }: { tkey: TypeKey; size?: "sm" | "md" }) {
  const m = TYPES[tkey];
  if (!m) return null;
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full font-semibold", size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs")} style={{ background: m.soft, color: m.text }}>
      <Icon name={m.icon} size={size === "sm" ? 12 : 13} />
      {m.label}
    </span>
  );
}

export function TypeDot({ tkey, size = 28 }: { tkey: TypeKey; size?: number }) {
  const m = TYPES[tkey];
  if (!m) return null;
  return (
    <span className="inline-flex items-center justify-center rounded-lg shrink-0" style={{ width: size, height: size, background: m.soft, color: m.text }}>
      <Icon name={m.icon} size={size * 0.5} />
    </span>
  );
}

export function StatusStackBar({ breakdown, width = 130, height = 8, showLegend = false }: { breakdown: BreakdownSeg[]; width?: number; height?: number; showLegend?: boolean }) {
  const total = breakdown.reduce((a, b) => a + b.value, 0) || 1;
  return (
    <div>
      <div className="flex rounded-full overflow-hidden" style={{ width, height, background: "#eef0f3" }}>
        {breakdown.map((b, i) => (
          <div key={i} title={`${STATUS[b.key].label}: ${fmtNum(b.value)}`} style={{ width: `${(b.value / total) * 100}%`, background: STATUS[b.key].color }} />
        ))}
      </div>
      {showLegend && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {breakdown.map((b, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS[b.key].color }} />
              {STATUS[b.key].label} {fmtNum(b.value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Sparkline ----------
export function Sparkline({ data, color = "var(--accent)", width = 96, height = 34 }: { data: { i: number; v: number }[]; color?: string; width?: number; height?: number }) {
  const id = useMemo(() => "sp" + Math.random().toString(36).slice(2, 8), []);
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 3, bottom: 3, left: 0, right: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${id})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- StatCard ----------
export function StatCard({ label, value, sub, delta, deltaGood = true, spark, icon, loading }: { label?: string; value?: ReactNode; sub?: ReactNode; delta?: number | null; deltaGood?: boolean; spark?: { i: number; v: number }[]; icon?: string; loading?: boolean }) {
  if (loading) {
    return (
      <Card className="p-5">
        <div className="skeleton h-4 w-24 mb-3" />
        <div className="skeleton h-8 w-28 mb-3" />
        <div className="skeleton h-8 w-full" />
      </Card>
    );
  }
  const up = delta != null && delta >= 0;
  const good = up === deltaGood;
  return (
    <Card className="p-5 fade-up">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
          {icon && (
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
              <Icon name={icon} size={15} />
            </span>
          )}
          {label}
        </div>
        {delta != null && (
          <span className={cx("inline-flex items-center gap-0.5 text-xs font-semibold rounded-full px-1.5 py-0.5", good ? "text-emerald-700 bg-emerald-50" : "text-red-700 bg-red-50")}>
            <Icon name={up ? "TrendingUp" : "TrendingDown"} size={12} />
            {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="text-[26px] font-extrabold tracking-tight text-slate-900 tabnum leading-none">{value}</div>
          {sub && <div className="mt-1.5 text-xs text-slate-400">{sub}</div>}
        </div>
        {spark && <Sparkline data={spark} />}
      </div>
    </Card>
  );
}

// ---------- Skeleton helpers ----------
export function SkeletonRow({ cols = 6 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-slate-100">
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: i === 0 ? "22%" : `${10 + (i % 3) * 4}%` }} />
      ))}
    </div>
  );
}

// ---------- EmptyState ----------
export function EmptyState({ icon = "Inbox", title, body, action }: { icon?: string; title?: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 mb-4">
        <Icon name={icon} size={26} />
      </div>
      <div className="text-[15px] font-semibold text-slate-700">{title}</div>
      {body && <div className="mt-1 text-sm text-slate-400 max-w-sm">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ---------- Job progress ----------
export function JobProgress({ label, value, total, status, tone = "accent", sub }: { label?: ReactNode; value: number; total?: number; status?: ReactNode; tone?: "accent" | "success"; sub?: ReactNode }) {
  const pct = total ? Math.min(100, Math.round((value / total) * 100)) : value;
  const barColor = tone === "success" ? "#16a34a" : "var(--accent)";
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="font-semibold text-slate-700 flex items-center gap-2">
          {tone === "success" ? <Icon name="CheckCircle2" size={16} className="text-emerald-500" /> : <Spinner size={14} />}
          {label}
        </span>
        <span className="tabnum text-slate-500 font-medium">{status}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300 ease-out" style={{ width: pct + "%", background: barColor }} />
      </div>
      {sub && <div className="mt-1.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, subtitle, icon, children, footer, size = "md", closeOnBackdrop = true }: { open: boolean; onClose?: () => void; title?: ReactNode; subtitle?: ReactNode; icon?: string; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl"; closeOnBackdrop?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] fade-in" onClick={() => closeOnBackdrop && onClose && onClose()} />
      <div className={cx("relative w-full bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[88vh] fade-up", widths[size])}>
        {title && (
          <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-100">
            {icon && (
              <span className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-xl shrink-0" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
                <Icon name={icon} size={18} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-bold text-slate-900">{title}</div>
              {subtitle && <div className="text-[13px] text-slate-400 mt-0.5">{subtitle}</div>}
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5 -mt-1 -mr-1.5 transition-colors">
              <Icon name="X" size={18} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-6 py-5 flex-1">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl flex items-center justify-end gap-2.5">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Checkbox ----------
export function Checkbox({ checked, indeterminate, onChange, label, sub, className, disabled, title }: { checked?: boolean; indeterminate?: boolean; onChange?: (v: boolean) => void; label?: ReactNode; sub?: ReactNode; className?: string; disabled?: boolean; title?: string }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label title={title} className={cx("flex items-start gap-2.5 select-none group", disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer", className)}>
      <span
        onClick={(e) => {
          e.preventDefault();
          if (!disabled) onChange && onChange(!checked);
        }}
        className={cx(
          "mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-all",
          checked || indeterminate ? "border-transparent text-white" : "border-slate-300 bg-white",
          !disabled && !(checked || indeterminate) && "group-hover:border-slate-400",
        )}
        style={{ background: checked || indeterminate ? "var(--accent)" : undefined }}
      >
        {checked ? <Icon name="Check" size={13} strokeWidth={3} /> : indeterminate ? <span className="h-0.5 w-2.5 rounded bg-white" /> : null}
      </span>
      {label && (
        <span>
          <span className="text-sm text-slate-700 leading-tight">{label}</span>
          {sub && <span className="block text-xs text-slate-400">{sub}</span>}
        </span>
      )}
    </label>
  );
}

// ---------- Switch ----------
export function Switch({ checked, onChange }: { checked?: boolean; onChange?: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange && onChange(!checked)} className={cx("relative inline-flex h-5 w-9 items-center rounded-full transition-colors", checked ? "" : "bg-slate-200")} style={{ background: checked ? "var(--accent)" : undefined }}>
      <span className={cx("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

// ---------- Segmented ----------
type SegOption = string | { value: string; label: ReactNode };
export function Segmented({ options, value, onChange, size = "md" }: { options: SegOption[]; value: string; onChange: (v: string) => void; size?: "sm" | "md" }) {
  return (
    <div className={cx("inline-flex items-center rounded-xl bg-slate-100 p-0.5", size === "sm" && "text-[13px]")}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const lbl = typeof o === "string" ? o : o.label;
        const active = v === value;
        return (
          <button key={v} onClick={() => onChange(v)} className={cx("rounded-lg font-semibold transition-all", size === "sm" ? "px-2.5 py-1 text-[12.5px]" : "px-3 py-1.5 text-[13px]", active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
            {lbl}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Dropdown ----------
export function Dropdown({ trigger, children, align = "left", width = 224 }: { trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: "left" | "right"; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className={cx("absolute z-40 mt-2 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl fade-up", align === "right" ? "right-0" : "left-0")} style={{ width }}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, shortcut, disabled, title }: { icon?: string; children?: ReactNode; onClick?: () => void; danger?: boolean; shortcut?: string; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
        disabled
          ? "text-slate-300 cursor-not-allowed"
          : danger
            ? "text-red-600 hover:bg-red-50"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      <span className="flex-1 text-left">{children}</span>
      {shortcut && <span className="text-xs text-slate-400 font-mono">{shortcut}</span>}
    </button>
  );
}

// ---------- Avatar ----------
export function Avatar({ name = "User", size = 36 }: { name?: string; size?: number }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="inline-flex items-center justify-center rounded-full text-white font-bold shrink-0" style={{ width: size, height: size, fontSize: size * 0.36, background: "var(--brand-grad)" }}>
      {initials}
    </span>
  );
}

// ---------- Tabs ----------
type TabDef = { value: string; label: ReactNode; icon?: string; count?: number | null };
export function Tabs({ tabs, value, onChange }: { tabs: TabDef[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 border-b border-slate-200">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button key={t.value} onClick={() => onChange(t.value)} className={cx("relative px-3.5 py-2.5 text-sm font-semibold transition-colors -mb-px flex items-center gap-1.5", active ? "text-[var(--accent-strong)]" : "text-slate-500 hover:text-slate-800")}>
            {t.icon && <Icon name={t.icon} size={15} />}
            {t.label}
            {t.count != null && <span className={cx("ml-0.5 rounded-full px-1.5 text-[11px] font-bold", active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "bg-slate-100 text-slate-500")}>{t.count}</span>}
            {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full" style={{ background: "var(--accent)" }} />}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Input ----------
export function Input({ icon, className, ...rest }: { icon?: string; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cx("relative flex items-center", className)}>
      {icon && <Icon name={icon} size={16} className="absolute left-3 text-slate-400 pointer-events-none" />}
      <input
        className={cx(
          "h-10 w-full rounded-xl border border-slate-200 bg-white text-sm text-slate-800 placeholder:text-slate-400 transition-all focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]",
          icon ? "pl-9 pr-3" : "px-3.5",
        )}
        {...rest}
      />
    </div>
  );
}

// ---------- ChartCard ----------
export function ChartCard({ title, subtitle, action, children, className, bodyClass }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <Card className={cx("p-5 fade-up", className)}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[15px] font-bold text-slate-900">{title}</div>
          {subtitle && <div className="text-xs text-slate-400 mt-0.5">{subtitle}</div>}
        </div>
        {action}
      </div>
      <div className={bodyClass}>{children}</div>
    </Card>
  );
}
