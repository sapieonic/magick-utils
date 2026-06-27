import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppProvider } from "@/lib/store";
import { getBrand, brandStyleVars } from "@/lib/brand";
import { BrandProvider } from "@/components/brand/BrandProvider";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Render on demand so the active brand (BRAND env) is resolved at request time,
// not frozen at build — one build can serve any brand across deployments.
export const dynamic = "force-dynamic";

// Runtime metadata: title/description follow the active brand, and the favicon
// is served per-brand from the /logo route (no static app/icon.png convention,
// so the tab icon stays brand-driven at runtime).
export function generateMetadata(): Metadata {
  const brand = getBrand();
  return {
    title: brand.name,
    description: brand.tagline,
    icons: { icon: "/logo" },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brand = getBrand();
  return (
    // Brand accent/gradient tokens are set inline on <html> so they override the
    // :root defaults in globals.css regardless of stylesheet order.
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable} h-full`} style={brandStyleVars(brand)}>
      <body className="min-h-full">
        <BrandProvider brand={brand}>
          <AppProvider>{children}</AppProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
