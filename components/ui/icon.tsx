"use client";
import { icons } from "lucide-react";
import type { CSSProperties } from "react";

// Map a few legacy lucide names used in the handoff to their canonical names.
const ALIASES: Record<string, string> = {
  CheckCircle2: "CircleCheck",
  AlertCircle: "CircleAlert",
  XCircle: "CircleX",
  MoreVertical: "EllipsisVertical",
  MoreHorizontal: "Ellipsis",
};

const REGISTRY = icons as unknown as Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }>>;

export function Icon({
  name,
  size = 18,
  strokeWidth = 2,
  className,
  style,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const Cmp = REGISTRY[name] || REGISTRY[ALIASES[name]];
  if (!Cmp) {
    return <span className={className} style={{ display: "inline-block", width: size, height: size, ...style }} />;
  }
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(" ");
}
