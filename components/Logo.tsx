"use client";
import Image from "next/image";
import { cx } from "@/components/ui";

export function Logo({ size = 40, withWordmark = true, light = false }: { size?: number; withWordmark?: boolean; light?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <Image src="/logo.png" alt="MagickUtils" width={size} height={size} style={{ objectFit: "contain" }} className="drop-shadow-sm" />
      {withWordmark && (
        <div className="leading-none">
          <div className={cx("text-[18px] font-extrabold tracking-tight", light ? "text-white" : "text-slate-900")}>
            Magick<span className="brand-text">Utils</span>
          </div>
          <div className={cx("text-[10.5px] font-semibold tracking-wide mt-0.5", light ? "text-white/60" : "text-slate-400")}>by MagickVoice</div>
        </div>
      )}
    </div>
  );
}
