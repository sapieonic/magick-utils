"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { backendStatus, fetchMe } from "@/lib/api";
import { useApp } from "@/lib/store";
import { useBrand } from "@/components/brand/BrandProvider";

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/campaigns": "Campaigns",
  "/combine": "Combine CSV",
  "/analytics": "Analytics",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { workspace, user, setUser, currency, setCurrency, dateRange, setDateRange, signOut } = useApp();
  const brand = useBrand();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  // Auth + workspace guard. With a live backend, verify the session first: an
  // expired/dead session (fetchMe ⇒ 401) sends the user to /login, NOT to the
  // workspace picker — otherwise stale workspace state in sessionStorage would
  // keep a signed-out user bouncing around the app. Once authenticated (or in
  // mock mode, where there's no real session), fall back to the workspace guard
  // and redirect to selection if none is chosen.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { backend } = await backendStatus();
      if (!alive) return;
      if (backend) {
        const me = await fetchMe().catch(() => null);
        if (!alive) return;
        if (!me?.authenticated) {
          router.replace("/login");
          return;
        }
        if (me.user) setUser(me.user);
      }
      const raw = typeof window !== "undefined" ? sessionStorage.getItem("mu_app_state_v1") : null;
      const hasWs = workspace || (raw && JSON.parse(raw)?.workspace);
      if (!hasWs) {
        router.replace("/workspace");
      } else {
        setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspace, router, setUser]);

  if (!ready || !workspace) {
    return <div className="min-h-screen w-full bg-[#f6f7f9]" />;
  }

  const switchWorkspace = () => router.push("/workspace");
  const doSignOut = () => {
    signOut();
    router.push("/login");
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f6f7f9]">
      <Sidebar workspace={workspace} collapsed={collapsed} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} onSwitch={switchWorkspace} />
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <Topbar
          title={TITLES[pathname] ?? brand.name}
          workspace={workspace}
          user={user}
          currency={currency}
          setCurrency={setCurrency}
          dateRange={dateRange}
          setDateRange={setDateRange}
          setCollapsed={setCollapsed}
          setMobileOpen={setMobileOpen}
          onSwitch={switchWorkspace}
          onSignout={doSignOut}
        />
        <main id="scroll-main" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
