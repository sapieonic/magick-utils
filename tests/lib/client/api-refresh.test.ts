// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/** Minimal Response double. `postRefresh` reads `ok`/`status` and, on a 2xx,
 *  the body's `persisted` flag. */
function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Replace window.location so the expiry redirect can be observed without jsdom
 *  attempting a real navigation. */
function stubLocation(pathname: string) {
  const loc = { pathname, href: `http://localhost${pathname}` };
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true });
  return loc;
}

const realLocation = window.location;

async function freshApi() {
  vi.resetModules();
  return import("@/lib/api");
}

beforeEach(() => stubLocation("/campaigns"));

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { value: realLocation, writable: true, configurable: true });
});

describe("postRefresh", () => {
  it("POSTs the ID token — and only the ID token — to the refresh route", async () => {
    let url = "";
    let init: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, i?: RequestInit) => {
        url = u;
        init = i;
        return res(200);
      }),
    );
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("delivered");
    // Never /api/auth/session: that route re-runs the login exchange, resets
    // tenants and logs a login line — once an hour, for a background refresh.
    expect(url).toBe("/api/auth/refresh");
    expect(init?.method).toBe("POST");
    // The refresh token is the durable credential and is set once, at login, by
    // the exchange that verified it. Re-supplying it from the page would let a
    // valid ID token be paired with someone else's refresh token, and the route
    // refuses to read one at all.
    expect(JSON.parse(String(init?.body))).toEqual({ idToken: "id-2" });
  });

  it("reports a verified-but-unsaved token as retryable", async () => {
    // 200 + persisted:false means the route checked the token but could not
    // write the cookie. Calling that delivered would let SessionRefresher mark
    // the token done and never offer it again, leaving the session on the old
    // one; reporting it retryable costs one attempt on the next wake.
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { ok: true, persisted: false })));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("retry");
    expect(window.location.href).toBe("http://localhost/campaigns");
  });

  it("treats a 200 with an unreadable body as delivered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response)));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("delivered");
  });

  it("reports failure without redirecting on a transient error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(502)));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("retry");
    // Upstream having a bad minute is not a dead session.
    expect(window.location.href).toBe("http://localhost/campaigns");
  });

  it("refuses — never retries — a token the route will not verify", async () => {
    // 403 means the route cannot confirm this token names the session's user,
    // and it will say the same thing every time. Reporting it retryable would
    // have the refresher re-offer the same credential on every token change,
    // every tab focus and every wake, forever, with nothing visible to the user.
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { error: "user_mismatch" })));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("refused");
    // Not a dead session, so no bounce — just an end to the asking.
    expect(window.location.href).toBe("http://localhost/campaigns");
  });

  it("sends the user to /login when the session is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(401)));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe("refused");
    // The route destroys the session on an upstream 401, so there is nothing
    // left to refresh — bouncing now beats being ejected mid-screen later.
    expect(window.location.href).toBe("/login");
  });

  it("does not bounce a user already sitting on /login", async () => {
    stubLocation("/login");
    vi.stubGlobal("fetch", vi.fn(async () => res(401)));
    const api = await freshApi();
    await api.postRefresh("id-2");
    expect(window.location.href).toBe("http://localhost/login");
  });
});

describe("postLogout", () => {
  it("POSTs to the logout route so the server session is destroyed", async () => {
    let url = "";
    let init: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, i?: RequestInit) => {
        url = u;
        init = i;
        return res(200);
      }),
    );
    const api = await freshApi();
    await api.postLogout();
    expect(url).toBe("/api/auth/logout");
    expect(init?.method).toBe("POST");
    // A cached 200 would leave the cookie alive while telling the tab otherwise.
    expect(init?.cache).toBe("no-store");
  });

  it("never throws, so a failed logout cannot strand the user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const api = await freshApi();
    await expect(api.postLogout()).resolves.toBeUndefined();
  });
});
