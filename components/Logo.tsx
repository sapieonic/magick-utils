"use client";
import Image from "next/image";
import { cx } from "@/components/ui";
import { useBrand } from "@/components/brand/BrandProvider";

export function Logo({ size = 40, withWordmark = true, light = false }: { size?: number; withWordmark?: boolean; light?: boolean }) {
  const brand = useBrand();
  return (
    <div className="flex items-center gap-2.5">
      {/* /logo serves the active brand's logo at runtime (also the favicon). unoptimized: it's a runtime route, not a static asset. */}
      <Image src="/logo" alt={brand.name} width={size} height={size} unoptimized style={{ objectFit: "contain" }} className="drop-shadow-sm" />
      {withWordmark && (
        <div className="leading-none">
          <div className={cx("text-[18px] font-extrabold tracking-tight", light ? "text-white" : "text-slate-900")}>
            {brand.wordmark.lead}
            <span className="brand-text">{brand.wordmark.accent}</span>
          </div>
          {brand.byline && <div className={cx("text-[10.5px] font-semibold tracking-wide mt-0.5", light ? "text-white/60" : "text-slate-400")}>{brand.byline}</div>}
        </div>
      )}
    </div>
  );
}
