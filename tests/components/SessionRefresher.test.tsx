// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  backendStatus: vi.fn(),
  postRefresh: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: vi.fn(() => true),
  watchIdToken: vi.fn(),
  currentIdToken: vi.fn(),
}));

import { SessionRefresher } from "@/components/SessionRefresher";
import { backendStatus, postRefresh } from "@/lib/api";
import { currentIdToken, isFirebaseConfigured, watchIdToken } from "@/lib/firebase";
import type { FirebaseCredential } from "@/lib/firebase";

/** Captures the subscriber the component registers, so a test can play the role
 *  of the Firebase SDK minting a new token. */
function captureWatcher() {
  const unsubscribe = vi.fn();
  let emit: ((cred: FirebaseCredential | null) => void) | null = null;
  vi.mocked(watchIdToken).mockImplementation((cb) => {
    emit = cb;
    return unsubscribe;
  });
  return {
    unsubscribe,
    async emit(cred: FirebaseCredential | null) {
      await waitFor(() => expect(emit).not.toBeNull());
      emit!(cred);
    },
  };
}

const CRED: FirebaseCredential = { idToken: "id-1", refreshToken: "refresh-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFirebaseConfigured).mockReturnValue(true);
  vi.mocked(backendStatus).mockResolvedValue({ backend: true, llm: false });
  vi.mocked(postRefresh).mockResolvedValue("delivered");
  vi.mocked(currentIdToken).mockResolvedValue(null);
});

describe("SessionRefresher", () => {
  it("stays out of the way when Firebase is unconfigured", async () => {
    vi.mocked(isFirebaseConfigured).mockReturnValue(false);
    render(<SessionRefresher />);
    // Mock mode and the token-paste flow have no SDK and no session to refresh.
    await waitFor(() => expect(backendStatus).not.toHaveBeenCalled());
    expect(watchIdToken).not.toHaveBeenCalled();
  });

  it("stays out of the way when the backend is off", async () => {
    vi.mocked(backendStatus).mockResolvedValue({ backend: false, llm: false });
    render(<SessionRefresher />);
    await waitFor(() => expect(backendStatus).toHaveBeenCalled());
    expect(watchIdToken).not.toHaveBeenCalled();
  });

  it("does not subscribe when backend availability cannot be verified", async () => {
    vi.mocked(backendStatus).mockRejectedValue(new Error("health unavailable"));
    render(<SessionRefresher />);
    await waitFor(() => expect(backendStatus).toHaveBeenCalled());
    expect(watchIdToken).not.toHaveBeenCalled();
  });

  it("subscribes on mount — which is what keeps the SDK refreshing at all", async () => {
    captureWatcher();
    render(<SessionRefresher />);
    await waitFor(() => expect(watchIdToken).toHaveBeenCalledTimes(1));
  });

  it("forwards each newly minted token to the BFF", async () => {
    const watcher = captureWatcher();
    render(<SessionRefresher />);
    await watcher.emit(CRED);
    // The ID token alone: the refresh token is set once at login and the route
    // refuses to read one from the page.
    await waitFor(() => expect(postRefresh).toHaveBeenCalledWith("id-1"));
  });

  it("ignores a signed-out notification", async () => {
    const watcher = captureWatcher();
    render(<SessionRefresher />);
    await watcher.emit(null);
    await new Promise((r) => setTimeout(r, 0));
    // Signing out is the app-shell guard's business, not the refresher's.
    expect(postRefresh).not.toHaveBeenCalled();
  });

  it("does not re-POST a token the server already has", async () => {
    const watcher = captureWatcher();
    render(<SessionRefresher />);
    await watcher.emit(CRED);
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(1));
    // onIdTokenChanged fires on every auth-state nudge, not only on a new token.
    await watcher.emit(CRED);
    await watcher.emit({ idToken: "id-2", refreshToken: "refresh-1" });
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(2));
    expect(vi.mocked(postRefresh).mock.calls.map((c) => c[0])).toEqual(["id-1", "id-2"]);
  });

  it("retries a token whose hand-off failed", async () => {
    const watcher = captureWatcher();
    vi.mocked(postRefresh).mockResolvedValueOnce("retry");
    render(<SessionRefresher />);
    await watcher.emit(CRED);
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(1));
    // Remembering a failed hand-off as delivered would leave the cookie on the
    // dead credential until the user was bounced to /login.
    await watcher.emit(CRED);
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(2));
  });

  it("stops offering a token the route refused", async () => {
    const watcher = captureWatcher();
    vi.mocked(postRefresh).mockResolvedValue("refused");
    render(<SessionRefresher />);
    await watcher.emit(CRED);
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(1));

    // A refusal is the server saying it will not take this credential, and it
    // will say the same next time. Treating that like a transient failure turned
    // the refresher into an unbounded retry loop — one attempt per token change,
    // per tab focus, per wake, forever, with no backoff and nothing the user
    // could see. Re-emitting the same credential must NOT ask again.
    await watcher.emit(CRED);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(postRefresh).toHaveBeenCalledTimes(1);
  });

  it("checks the token when a slept tab comes back", async () => {
    captureWatcher();
    vi.mocked(currentIdToken).mockResolvedValue({ idToken: "id-wake", refreshToken: "refresh-1" });
    render(<SessionRefresher />);
    await waitFor(() => expect(watchIdToken).toHaveBeenCalled());

    document.dispatchEvent(new Event("visibilitychange"));
    // A sleeping laptop fires no timers, so the wake path is the only thing that
    // makes the ">1h idle tab" case deterministic.
    await waitFor(() => expect(postRefresh).toHaveBeenCalledWith("id-wake"));
  });

  it("also checks on window focus", async () => {
    captureWatcher();
    vi.mocked(currentIdToken).mockResolvedValue({ idToken: "id-focus", refreshToken: "refresh-1" });
    render(<SessionRefresher />);
    await waitFor(() => expect(watchIdToken).toHaveBeenCalled());
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(postRefresh).toHaveBeenCalledWith("id-focus"));
  });

  it("unsubscribes and detaches its listeners on unmount", async () => {
    const watcher = captureWatcher();
    vi.mocked(currentIdToken).mockResolvedValue({ idToken: "id-wake", refreshToken: "refresh-1" });
    const view = render(<SessionRefresher />);
    await waitFor(() => expect(watchIdToken).toHaveBeenCalled());

    view.unmount();
    expect(watcher.unsubscribe).toHaveBeenCalled();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 0));
    // Cleanup has to be symmetric: React 19 tears down Effects in a hidden
    // <Activity> subtree, and a listener left behind would keep POSTing from a
    // component that no longer exists.
    expect(currentIdToken).not.toHaveBeenCalled();
    expect(postRefresh).not.toHaveBeenCalled();
  });
});
