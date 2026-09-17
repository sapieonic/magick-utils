// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/** Minimal Response double — these calls only read `ok`/`status`. */
function res(status: number) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as unknown as Response;
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
  it("POSTs both halves of the credential to the refresh route", async () => {
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
    await expect(api.postRefresh("id-2", "refresh-2")).resolves.toBe(true);
    // Never /api/auth/session: that route re-runs the login exchange, resets
    // tenants and logs a login line — once an hour, for a background refresh.
    expect(url).toBe("/api/auth/refresh");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ idToken: "id-2", refreshToken: "refresh-2" });
  });

  it("omits the refresh token when the caller has none", async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, i?: RequestInit) => {
        init = i;
        return res(200);
      }),
    );
    const api = await freshApi();
    await api.postRefresh("id-2");
    // Sending `refreshToken: undefined` would serialize away anyway, but an
    // explicit key invites the route to overwrite a perfectly good stored one.
    expect(JSON.parse(String(init?.body))).toEqual({ idToken: "id-2" });
  });

  it("reports failure without redirecting on a transient error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(502)));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe(false);
    // Upstream having a bad minute is not a dead session.
    expect(window.location.href).toBe("http://localhost/campaigns");
  });

  it("sends the user to /login when the session is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(401)));
    const api = await freshApi();
    await expect(api.postRefresh("id-2")).resolves.toBe(false);
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
