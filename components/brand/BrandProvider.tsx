"use client";
import { createContext, useContext } from "react";
import { type Brand, DEFAULT_BRAND } from "@/lib/brand-types";

// Carries the active brand (resolved on the server, passed down from the root
// layout) to client components — Logo, login screen, Topbar title, etc.

const BrandContext = createContext<Brand>(DEFAULT_BRAND);

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

/** The active brand. Falls back to MagickVoice if no provider is mounted. */
export function useBrand(): Brand {
  return useContext(BrandContext);
}
