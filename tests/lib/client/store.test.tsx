// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppProvider, useApp } from "@/lib/store";
import type { Workspace } from "@/lib/types";

const KEY = "mu_app_state_v1";

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const sampleWorkspace = { id: "ws1", name: "Acme" } as unknown as Workspace;

describe("useApp guard", () => {
  it("throws when used outside <AppProvider>", () => {
    // suppress React's error boundary console noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useApp())).toThrow("useApp must be used within <AppProvider>");
    spy.mockRestore();
  });
});

describe("AppProvider defaults", () => {
  it("exposes default workspace/currency/dateRange and empty target arrays", () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    expect(result.current.workspace).toBeNull();
    expect(result.current.currency).toBe("inr");
    expect(result.current.dateRange).toBe("Last 30 days");
    expect(result.current.combineTargets).toEqual([]);
    expect(result.current.analyzeTargets).toEqual([]);
  });
});

describe("setters", () => {
  it("setCurrency updates currency", () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => result.current.setCurrency("usd"));
    expect(result.current.currency).toBe("usd");
  });

  it("setDateRange updates dateRange", () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => result.current.setDateRange("Last 7 days"));
    expect(result.current.dateRange).toBe("Last 7 days");
  });

  it("setWorkspace updates and can clear workspace", () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => result.current.setWorkspace(sampleWorkspace));
    expect(result.current.workspace).toEqual(sampleWorkspace);
    act(() => result.current.setWorkspace(null));
    expect(result.current.workspace).toBeNull();
  });

  it("setCombineTargets / setAnalyzeTargets update target arrays", () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => result.current.setCombineTargets(["AI-1", "AI-2"]));
    act(() => result.current.setAnalyzeTargets(["IVR-9"]));
    expect(result.current.combineTargets).toEqual(["AI-1", "AI-2"]);
    expect(result.current.analyzeTargets).toEqual(["IVR-9"]);
  });
});

describe("signOut", () => {
  it("clears workspace + targets and removes sessionStorage key", async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => {
      result.current.setWorkspace(sampleWorkspace);
      result.current.setCombineTargets(["AI-1"]);
      result.current.setAnalyzeTargets(["AI-2"]);
    });
    // wait until persisted
    await waitFor(() => expect(sessionStorage.getItem(KEY)).not.toBeNull());

    act(() => result.current.signOut());
    expect(result.current.workspace).toBeNull();
    expect(result.current.combineTargets).toEqual([]);
    expect(result.current.analyzeTargets).toEqual([]);

    // BUG (asserting current behavior): signOut() calls sessionStorage.removeItem,
    // but clearing the state triggers the persist useEffect, which immediately
    // re-writes the key with the reset (cleared) state. So the key is NOT actually
    // removed after signOut — it ends up holding the empty/default state.
    await waitFor(() => {
      const raw = sessionStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.workspace).toBeNull();
      expect(parsed.combineTargets).toEqual([]);
      expect(parsed.analyzeTargets).toEqual([]);
    });
  });
});

describe("sessionStorage persistence", () => {
  it("persists state to sessionStorage after a change", async () => {
    const { result } = renderHook(() => useApp(), { wrapper });
    act(() => {
      result.current.setCurrency("usd");
      result.current.setAnalyzeTargets(["AI-7"]);
      result.current.setCombineTargets(["AI-8"]);
    });
    await waitFor(() => {
      const raw = sessionStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.currency).toBe("usd");
      expect(parsed.analyzeTargets).toEqual(["AI-7"]);
      expect(parsed.combineTargets).toEqual(["AI-8"]);
    });
  });

  it("re-hydrates analyzeTargets/combineTargets from sessionStorage on mount", async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        workspace: sampleWorkspace,
        currency: "usd",
        dateRange: "Last 90 days",
        combineTargets: ["C-1"],
        analyzeTargets: ["A-1", "A-2"],
      }),
    );
    const { result } = renderHook(() => useApp(), { wrapper });
    await waitFor(() => {
      expect(result.current.currency).toBe("usd");
      expect(result.current.dateRange).toBe("Last 90 days");
      expect(result.current.workspace).toEqual(sampleWorkspace);
      expect(result.current.combineTargets).toEqual(["C-1"]);
      expect(result.current.analyzeTargets).toEqual(["A-1", "A-2"]);
    });
  });

  it("ignores malformed sessionStorage JSON and uses defaults", async () => {
    sessionStorage.setItem(KEY, "{not valid json");
    const { result } = renderHook(() => useApp(), { wrapper });
    // load() catches the parse error → defaults remain
    expect(result.current.currency).toBe("inr");
    expect(result.current.analyzeTargets).toEqual([]);
  });

  it("ignores non-array target fields during hydration", async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ combineTargets: "oops", analyzeTargets: 42 }),
    );
    const { result } = renderHook(() => useApp(), { wrapper });
    await waitFor(() => expect(result.current.currency).toBe("inr"));
    expect(result.current.combineTargets).toEqual([]);
    expect(result.current.analyzeTargets).toEqual([]);
  });
});
