"use client";

import { Dropdown, Icon, MenuItem, cx } from "@/components/ui";

interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  icon,
  label,
  value,
  onChange,
  options,
}: {
  icon: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
}) {
  const current = options.find((o) => o.value === value);
  const isAll = value === "all";
  return (
    <Dropdown
      align="left"
      width={210}
      trigger={
        <button
          className={cx(
            "flex items-center gap-2 h-10 rounded-xl border bg-white px-3 text-[13px] font-semibold transition-colors",
            isAll
              ? "border-slate-200 text-slate-600 hover:border-slate-300"
              : "border-[var(--accent)] text-[var(--accent-strong)]"
          )}
          style={!isAll ? { background: "var(--accent-soft)" } : undefined}
        >
          <Icon name={icon} size={15} className={isAll ? "text-slate-400" : ""} />
          <span className="hidden sm:inline">{current ? current.label : label}</span>
          <Icon name="ChevronDown" size={14} className="text-slate-400" />
        </button>
      }
    >
      {(close) => (
        <div className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              icon={o.value === value ? "Check" : undefined}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              {o.label}
            </MenuItem>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
