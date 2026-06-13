"use client";
// App-wide client state: selected workspace, currency, date range, and the
// ephemeral batch-id selection passed into Combine / Analytics. Persisted to
// sessionStorage so a refresh inside the app keeps context.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Currency, Workspace } from "./types";

interface AppState {
  workspace: Workspace | null;
  setWorkspace: (w: Workspace | null) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  dateRange: string;
  setDateRange: (r: string) => void;
  combineTargets: string[];
  setCombineTargets: (ids: string[]) => void;
  analyzeTargets: string[];
  setAnalyzeTargets: (ids: string[]) => void;
  signOut: () => void;
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
  const [currency, setCurrencyState] = useState<Currency>("inr");
  const [dateRange, setDateRangeState] = useState<string>("Last 30 days");
  const [combineTargets, setCombineTargetsState] = useState<string[]>([]);
  const [analyzeTargets, setAnalyzeTargetsState] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // hydrate from sessionStorage on mount
  useEffect(() => {
    const s = load();
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

  const signOut = useCallback(() => {
    sessionStorage.removeItem(KEY);
    setWorkspaceState(null);
    setCombineTargetsState([]);
    setAnalyzeTargetsState([]);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      workspace,
      setWorkspace: setWorkspaceState,
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
    [workspace, currency, dateRange, combineTargets, analyzeTargets, signOut],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
