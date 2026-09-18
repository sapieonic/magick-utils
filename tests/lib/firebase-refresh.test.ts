import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A fake `Auth` with a settable `currentUser`, shared with the module mocks below.
const h = vi.hoisted(() => {
  const listeners: ((user: unknown) => void)[] = [];
  return {
    listeners,
    auth: { currentUser: null as unknown },
    unsubscribe: vi.fn(),
  };
});

vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => ({ name: "app" })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: "app" })),
}));

vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => h.auth),
  GoogleAuthProvider: class {},
  signInWithPopup: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  onIdTokenChanged: vi.fn((_auth: unknown, cb: (user: unknown) => void) => {
    h.listeners.push(cb);
    return h.unsubscribe;
  }),
  signOut: vi.fn(async () => {}),
}));

import {
  getAuth,
  onIdTokenChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

/** A `User` double: `getIdToken(force)` plus the rotating `refreshToken` field. */
function fakeUser(idToken = "id-1", refreshToken = "refresh-1") {
  return {
    getIdToken: vi.fn(async () => idToken),
    refreshToken,
  };
}

function configure() {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "example.firebaseapp.com");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "proj");
}

/** Config is read once at module scope, so each test imports a fresh copy. */
async function load() {
  vi.resetModules();
  return import("@/lib/firebase");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.length = 0;
  h.auth.currentUser = null;
});

afterEach(() => vi.unstubAllEnvs());

describe("lib/firebase with no NEXT_PUBLIC_FIREBASE_* config", () => {
  it("never touches the SDK and never throws", async () => {
    const fb = await load();
    expect(fb.isFirebaseConfigured()).toBe(false);

    // Mock mode and the local token-paste login both run with no Firebase at
    // all; a throw from any of this would take the app shell down with it.
    const unwatch = fb.watchIdToken(() => {
      throw new Error("must not be called");
    });
    expect(() => unwatch()).not.toThrow();
    await expect(fb.currentIdToken()).resolves.toBeNull();
    await expect(fb.firebaseSignOut()).resolves.toBeUndefined();
    expect(getAuth).not.toHaveBeenCalled();
    expect(onIdTokenChanged).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("firebaseSignOut", () => {
  it("signs the SDK out, clearing the refresh token it keeps in IndexedDB", async () => {
    // Without this, "Sign out" left the browser holding a credential that can
    // mint new ID tokens indefinitely — so the refresher could hand the next
    // person at a shared machine a working session.
    configure();
    const fb = await load();

    await fb.firebaseSignOut();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith(h.auth);
  });

  it("never throws, so the server session is still destroyed", async () => {
    configure();
    const fb = await load();
    vi.mocked(signOut).mockRejectedValueOnce(new Error("already signed out"));

    // Destroying the server cookie is the part that actually matters; failing
    // here must not abort it.
    await expect(fb.firebaseSignOut()).resolves.toBeUndefined();
  });
});

describe("watchIdToken", () => {
  it("instantiates Auth — which is what restarts the SDK's refresh scheduler", async () => {
    configure();
    const fb = await load();
    fb.watchIdToken(() => {});
    // The original bug: outside /login no `Auth` object existed, so nothing ever
    // re-minted the hour-long ID token behind the 8h cookie.
    expect(getAuth).toHaveBeenCalled();
    expect(onIdTokenChanged).toHaveBeenCalled();
  });

  it("hands the callback the id token and the live refresh token", async () => {
    configure();
    const fb = await load();
    const seen: unknown[] = [];
    fb.watchIdToken((cred) => seen.push(cred));

    const user = fakeUser("id-new", "refresh-new");
    h.listeners[0](user);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ idToken: "id-new", refreshToken: "refresh-new" });
    // Not forced: the SDK just minted this token, a network round trip adds nothing.
    expect(user.getIdToken).toHaveBeenCalledWith(false);
  });

  it("reports a signed-out user as null rather than silently doing nothing", async () => {
    configure();
    const fb = await load();
    const seen: unknown[] = [];
    fb.watchIdToken((cred) => seen.push(cred));
    h.listeners[0](null);
    expect(seen).toEqual([null]);
  });

  it("swallows a getIdToken failure into a null credential", async () => {
    configure();
    const fb = await load();
    const seen: unknown[] = [];
    fb.watchIdToken((cred) => seen.push(cred));
    const user = { getIdToken: vi.fn().mockRejectedValue(new Error("offline")), refreshToken: "r" };
    h.listeners[0](user);
    // An unhandled rejection in a background refresher must not surface as an
    // app-level error; the next tick or wake tries again.
    await vi.waitFor(() => expect(seen).toEqual([null]));
  });

  it("returns the SDK's unsubscribe so the listener can be torn down", async () => {
    configure();
    const fb = await load();
    fb.watchIdToken(() => {})();
    expect(h.unsubscribe).toHaveBeenCalled();
  });
});

describe("currentIdToken", () => {
  it("returns null before a user has been restored", async () => {
    configure();
    const fb = await load();
    await expect(fb.currentIdToken()).resolves.toBeNull();
  });

  it("re-reads the credential off the current user on demand", async () => {
    configure();
    const fb = await load();
    const user = fakeUser("id-wake", "refresh-wake");
    h.auth.currentUser = user;
    // The wake path: a slept laptop fires no refresh timer and no
    // onIdTokenChanged, so the token has to be asked for explicitly.
    await expect(fb.currentIdToken()).resolves.toEqual({ idToken: "id-wake", refreshToken: "refresh-wake" });
    expect(user.getIdToken).toHaveBeenCalledWith(false);
  });

  it("passes `force` through for a caller that needs a network mint", async () => {
    configure();
    const fb = await load();
    const user = fakeUser();
    h.auth.currentUser = user;
    await fb.currentIdToken(true);
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it("returns null when the token cannot be obtained", async () => {
    configure();
    const fb = await load();
    h.auth.currentUser = { getIdToken: vi.fn().mockRejectedValue(new Error("offline")), refreshToken: "r" };
    await expect(fb.currentIdToken()).resolves.toBeNull();
  });
});

describe("sign-in", () => {
  it("google sign-in yields both halves of the credential", async () => {
    configure();
    const fb = await load();
    vi.mocked(signInWithPopup).mockResolvedValue({ user: fakeUser("id-g", "refresh-g") } as never);
    // The refresh token is the whole reason the cookie can outlive the hour.
    await expect(fb.googleSignIn()).resolves.toEqual({ idToken: "id-g", refreshToken: "refresh-g" });
  });

  it("email sign-in yields both halves of the credential", async () => {
    configure();
    const fb = await load();
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({ user: fakeUser("id-e", "refresh-e") } as never);
    await expect(fb.emailSignIn("a@b.com", "pw")).resolves.toEqual({ idToken: "id-e", refreshToken: "refresh-e" });
  });
});
