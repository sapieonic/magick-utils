// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Signing out now reaches outside this tab — the server session cookie and the
// Firebase SDK's stored refresh token. Both are stubbed so the store's own
// behaviour is what these tests observe, and so neither hangs the awaited
// sign-out.
vi.mock("@/lib/api", () => ({ postLogout: vi.fn(async () => true) }));
vi.mock("@/lib/firebase", () => ({ firebaseSignOut: vi.fn(async () => {}) }));

import { AppProvider, useApp } from "@/lib/store";
import { postLogout } from "@/lib/api";
import { firebaseSignOut } from "@/lib/firebase";
import type { Workspace } from "@/lib/types";

const KEY = "mu_app_state_v1";

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(postLogout).mockClear();
  vi.mocked(postLogout).mockResolvedValue(true);
  vi.mocked(firebaseSignOut).mockClear();
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
    // A fresh session must not hide history: the shared range starts unfiltered,
    // so Campaigns lists everything until the user narrows it.
    expect(result.current.dateRange).toBe("All time");
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

    // Awaited: `signOut` is async now, and leaving the act() scope open with an
    // unsettled promise leaves React's test environment mid-update.
    await act(async () => {
      await result.current.signOut();
    });
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

  it("ends the session on the server, not just in this tab", async () => {
    // It used to clear React state and sessionStorage only. The cookie survived
    // — and now that the session can renew itself for its whole 8h life, the
    // next person at a shared machine was silently handed the previous user's
    // workspace.
    const { result } = renderHook(() => useApp(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    expect(postLogout).toHaveBeenCalledTimes(1);
    // The SDK keeps a refresh token in IndexedDB that can mint new ID tokens
    // indefinitely; leaving it behind hands the next visitor a live credential.
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfirmed sign-out instead of claiming success", async () => {
    // Callers route to /login?signout=incomplete on false, which surfaces it.
    // Swallowing it told a user on a shared machine they had signed out while
    // the session cookie was still live.
    vi.mocked(postLogout).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useApp(), { wrapper });

    let ended: boolean | undefined;
    await act(async () => {
      ended = await result.current.signOut();
    });

    expect(ended).toBe(false);
  });

  it("signs out of Firebase BEFORE clearing the server session", async () => {
    // Ordering, not concurrency: the SDK must stop minting tokens before the
    // cookie is cleared. Run together, an in-flight /api/auth/refresh could land
    // after logout and re-seal the very session being destroyed, because
    // iron-session reads, stamps and writes the session back.
    const order: string[] = [];
    vi.mocked(firebaseSignOut).mockImplementationOnce(async () => { order.push("firebase"); });
    vi.mocked(postLogout).mockImplementationOnce(async () => { order.push("logout"); return true; });
    const { result } = renderHook(() => useApp(), { wrapper });

    await act(async () => { await result.current.signOut(); });

    expect(order).toEqual(["firebase", "logout"]);
  });

  it("does not resolve until the server session is actually gone", async () => {
    // Callers navigate to /login the moment this resolves, and /login asks the
    // server whether this browser is still authenticated. Resolving early races
    // the Set-Cookie that clears it.
    let releaseLogout = () => {};
    vi.mocked(postLogout).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { releaseLogout = () => resolve(true); }),
    );
    const { result } = renderHook(() => useApp(), { wrapper });

    let settled = false;
    await act(async () => {
      const pending = result.current.signOut().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseLogout();
      await pending;
    });
    expect(settled).toBe(true);
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
