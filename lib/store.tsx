"use client";
// App-wide client state: selected workspace, currency, date range, and the
// ephemeral batch-id selection passed into Combine / Analytics. Persisted to
// sessionStorage so a refresh inside the app keeps context.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Currency, Workspace } from "./types";
import { postLogout, type SessionUserInfo } from "./api";
import { firebaseSignOut } from "./firebase";

interface AppState {
  workspace: Workspace | null;
  setWorkspace: (w: Workspace | null) => void;
  user: SessionUserInfo | null;
  setUser: (u: SessionUserInfo | null) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  dateRange: string;
  setDateRange: (r: string) => void;
  combineTargets: string[];
  setCombineTargets: (ids: string[]) => void;
  analyzeTargets: string[];
  setAnalyzeTargets: (ids: string[]) => void;
  signOut: () => Promise<boolean>;
}

const AppCtx = createContext<AppState | null>(null);

const KEY = "mu_app_state_v1";

function load(): Partial<AppState> & { workspace?: Workspace | null } {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspaceState] = useState<Workspace | null>(null);
  // Signed-in identity from the session (fetched by the app layout). Kept in
  // memory only — re-derived via fetchMe() on load, not persisted.
  const [user, setUserState] = useState<SessionUserInfo | null>(null);
  const [currency, setCurrencyState] = useState<Currency>("inr");
  // "All time" is the only honest default for a shared range control: Campaigns
  // is an inventory screen, and any narrower default hides history the customer
  // never asked to hide. Narrowing stays one click away in the Topbar (and in the
  // Campaigns filter bar), and survives the session via sessionStorage.
  const [dateRange, setDateRangeState] = useState<string>("All time");
  const [combineTargets, setCombineTargetsState] = useState<string[]>([]);
  const [analyzeTargets, setAnalyzeTargetsState] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // hydrate from sessionStorage on mount
  useEffect(() => {
    const s = load();
    // Hydration intentionally applies one external sessionStorage snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (s.workspace) setWorkspaceState(s.workspace as Workspace);
    if (s.currency) setCurrencyState(s.currency as Currency);
    if (s.dateRange) setDateRangeState(s.dateRange as string);
    if (Array.isArray(s.combineTargets)) setCombineTargetsState(s.combineTargets as string[]);
    if (Array.isArray(s.analyzeTargets)) setAnalyzeTargetsState(s.analyzeTargets as string[]);
    setHydrated(true);
  }, []);

  // persist
  useEffect(() => {
    if (!hydrated) return;
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ workspace, currency, dateRange, combineTargets, analyzeTargets }),
    );
  }, [hydrated, workspace, currency, dateRange, combineTargets, analyzeTargets]);

  /** Ends the session everywhere it exists: the server cookie, the Firebase
   *  SDK's stored refresh token, and this tab's state.
   *
   *  It used to clear only the last of those. The cookie survived, and so did
   *  the refresh token in IndexedDB — so on a shared machine the next person to
   *  open the app was silently handed the previous user's workspace. Harmless
   *  while the cookie's credential expired within the hour; not once the session
   *  can renew itself for its whole life.
   *
   *  Awaited by callers before they navigate, so the Set-Cookie that clears the
   *  session lands before the next screen asks whether it is authenticated.
   *
   *  Returns false when the server did NOT confirm the session was destroyed,
   *  so the caller can say so rather than showing a sign-out that did not
   *  happen. Ordered, not concurrent: Firebase goes first so the SDK stops
   *  minting tokens before the cookie is cleared, which closes the window where
   *  an in-flight `/api/auth/refresh` could land after logout and re-seal the
   *  very session being destroyed. `postLogout()` also latches a flag that stops
   *  this tab issuing any further refresh. (A refresh already in flight when the
   *  click lands, or one from another tab, is not covered — that would need a
   *  shared abort channel.) */
  const signOut = useCallback(async () => {
    sessionStorage.removeItem(KEY);
    setWorkspaceState(null);
    setUserState(null);
    setCombineTargetsState([]);
    setAnalyzeTargetsState([]);
    await firebaseSignOut();
    return postLogout();
  }, []);

  const value = useMemo<AppState>(
    () => ({
      workspace,
      setWorkspace: setWorkspaceState,
      user,
      setUser: setUserState,
      currency,
      setCurrency: setCurrencyState,
      dateRange,
      setDateRange: setDateRangeState,
      combineTargets,
      setCombineTargets: setCombineTargetsState,
      analyzeTargets,
      setAnalyzeTargets: setAnalyzeTargetsState,
      signOut,
    }),
    [workspace, user, currency, dateRange, combineTargets, analyzeTargets, signOut],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
