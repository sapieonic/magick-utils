import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above the module scope, so the mutable env
// they close over has to be hoisted with them.
const envMock = vi.hoisted(() => ({ firebaseApiKey: "test-key" }));

vi.mock("@/lib/server/env", () => ({
  env: envMock,
  isTokenRefreshConfigured: () => Boolean(envMock.firebaseApiKey),
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  idTokenExpiresAt,
  idTokenNeedsRefresh,
  mintIdToken,
  REFRESH_SKEW_MS,
  TokenRefreshPermanentError,
  TokenRefreshTransientError,
} from "@/lib/server/firebase-token";

/** A JWT that only needs to carry a readable `exp` — nothing here verifies
 *  signatures, and deliberately so (see the module's own note). */
function jwt(expSeconds: number | null): string {
  const payload = expSeconds === null ? {} : { exp: expSeconds };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

function errResponse(status: number, body: string): Response {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  envMock.firebaseApiKey = "test-key";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("idTokenExpiresAt", () => {
  it("reads the exp claim as epoch ms", () => {
    expect(idTokenExpiresAt(jwt(1_700_000_000))).toBe(1_700_000_000_000);
  });

  it("returns null for a token that is not a readable JWT", () => {
    expect(idTokenExpiresAt("not-a-jwt")).toBeNull();
    expect(idTokenExpiresAt("")).toBeNull();
    expect(idTokenExpiresAt("a.!!!notbase64!!!.c")).toBeNull();
  });

  it("returns null when the payload carries no exp", () => {
    expect(idTokenExpiresAt(jwt(null))).toBeNull();
  });
});

describe("idTokenNeedsRefresh", () => {
  const now = 1_700_000_000_000;

  it("is false while the token is comfortably live", () => {
    const token = jwt((now + 30 * 60 * 1000) / 1000);
    expect(idTokenNeedsRefresh(token, now)).toBe(false);
  });

  it("is true once the token is inside the refresh skew", () => {
    const token = jwt((now + REFRESH_SKEW_MS - 1000) / 1000);
    expect(idTokenNeedsRefresh(token, now)).toBe(true);
  });

  it("is true for an already-expired token", () => {
    const token = jwt((now - 60 * 1000) / 1000);
    expect(idTokenNeedsRefresh(token, now)).toBe(true);
  });

  it("treats an unreadable token as needing refresh rather than trusting it", () => {
    // Forwarding a token we cannot even parse just buys a 401 from upstream.
    expect(idTokenNeedsRefresh("garbage", now)).toBe(true);
  });
});

describe("mintIdToken", () => {
  it("returns the new token and prefers the token's own exp claim", async () => {
    const fresh = jwt(1_800_000_000);
    fetchMock.mockResolvedValue(
      okResponse({ id_token: fresh, refresh_token: "rotated", expires_in: "3600" }),
    );

    const minted = await mintIdToken("original");

    expect(minted.idToken).toBe(fresh);
    expect(minted.refreshToken).toBe("rotated");
    expect(minted.expiresAt).toBe(1_800_000_000_000);
  });

  it("keeps the refresh token it sent when Google returns none", async () => {
    // Dropping the credential here would leave the session unable to refresh again.
    fetchMock.mockResolvedValue(okResponse({ id_token: jwt(1_800_000_000), expires_in: "3600" }));

    const minted = await mintIdToken("original");

    expect(minted.refreshToken).toBe("original");
  });

  it("falls back to expires_in when the token carries no exp", async () => {
    fetchMock.mockResolvedValue(okResponse({ id_token: jwt(null), expires_in: "3600" }));

    const before = Date.now();
    const minted = await mintIdToken("original");

    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("posts a refresh_token grant to the secure-token endpoint with the API key", async () => {
    fetchMock.mockResolvedValue(okResponse({ id_token: jwt(1_800_000_000) }));

    await mintIdToken("original");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("securetoken.googleapis.com");
    expect(url).toContain("key=test-key");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=original");
  });

  describe("permanent failures (re-login required)", () => {
    it.each(["TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN"])(
      "treats %s as permanent",
      async (reason) => {
        fetchMock.mockResolvedValue(errResponse(400, JSON.stringify({ error: { message: reason } })));

        await expect(mintIdToken(`rt-${reason}`)).rejects.toBeInstanceOf(TokenRefreshPermanentError);
      },
    );

    it("tolerates Google appending detail after the code", async () => {
      fetchMock.mockResolvedValue(
        errResponse(400, JSON.stringify({ error: { message: "TOKEN_EXPIRED : the token expired" } })),
      );

      await expect(mintIdToken("rt-detail")).rejects.toBeInstanceOf(TokenRefreshPermanentError);
    });

    it("rejects an empty refresh token without calling out", async () => {
      await expect(mintIdToken("")).rejects.toBeInstanceOf(TokenRefreshPermanentError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("transient failures (keep the session)", () => {
    it("does not condemn a session on an UNRECOGNISED 400", async () => {
      // Guessing "permanent" wrongly signs a working user out, so anything not
      // on the known-terminal list has to stay retryable.
      fetchMock.mockResolvedValue(errResponse(400, JSON.stringify({ error: { message: "SOMETHING_NEW" } })));

      await expect(mintIdToken("rt-unknown")).rejects.toBeInstanceOf(TokenRefreshTransientError);
    });

    it("does not condemn a session on a non-JSON error body", async () => {
      // A proxy in front of Google emitting HTML is not Google refusing the grant.
      fetchMock.mockResolvedValue(errResponse(400, "<html>Bad Gateway</html>"));

      await expect(mintIdToken("rt-html")).rejects.toBeInstanceOf(TokenRefreshTransientError);
    });

    it("treats a 5xx as transient", async () => {
      fetchMock.mockResolvedValue(errResponse(503, ""));

      await expect(mintIdToken("rt-503")).rejects.toBeInstanceOf(TokenRefreshTransientError);
    });

    it("treats a network fault as transient", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNRESET"));

      await expect(mintIdToken("rt-net")).rejects.toBeInstanceOf(TokenRefreshTransientError);
    });

    it("treats a 2xx with no id_token as transient", async () => {
      fetchMock.mockResolvedValue(okResponse({ refresh_token: "rotated" }));

      await expect(mintIdToken("rt-empty")).rejects.toBeInstanceOf(TokenRefreshTransientError);
    });

    it("treats a missing API key as transient rather than a dead credential", async () => {
      envMock.firebaseApiKey = "";

      await expect(mintIdToken("rt-nokey")).rejects.toBeInstanceOf(TokenRefreshTransientError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("coalesces concurrent refreshes of the same token into one exchange", async () => {
    // A dashboard load fires several API calls at once; without coalescing each
    // one independently hits Google and the last writer wins the cookie.
    fetchMock.mockImplementation(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(okResponse({ id_token: jwt(1_800_000_000) })), 10),
        ),
    );

    const [a, b, c] = await Promise.all([
      mintIdToken("shared"),
      mintIdToken("shared"),
      mintIdToken("shared"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.idToken).toBe(b.idToken);
    expect(b.idToken).toBe(c.idToken);
  });

  it("does not cache a settled exchange, so a later refresh calls out again", async () => {
    fetchMock.mockResolvedValue(okResponse({ id_token: jwt(1_800_000_000) }));

    await mintIdToken("sequential");
    await mintIdToken("sequential");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
