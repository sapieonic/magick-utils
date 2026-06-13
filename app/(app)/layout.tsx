"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { fetchMe, type SessionUserInfo } from "@/lib/api";
import { useApp } from "@/lib/store";

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/campaigns": "Campaigns",
  "/combine": "Combine CSV",
  "/analytics": "Analytics",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { workspace, currency, setCurrency, dateRange, setDateRange, signOut } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUserInfo | null>(null);

  // Load the real signed-in user from the session (null on the mock/no-backend
  // path, where the Topbar falls back to a generic label).
  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((me) => {
        if (alive && me?.user) setUser(me.user);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // workspace guard — redirect to selection if none chosen
  useEffect(() => {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem("mu_app_state_v1") : null;
    const hasWs = workspace || (raw && JSON.parse(raw)?.workspace);
    if (!hasWs) {
      router.replace("/workspace");
    } else {
      setReady(true);
    }
  }, [workspace, router]);

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
          title={TITLES[pathname] ?? "MagickUtils"}
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
