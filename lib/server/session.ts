// Encrypted httpOnly session (iron-session). Stores the Firebase ID token and
// the chosen tenant/account so the BFF can call magick-master on every request.

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { env, isAuthConfigured } from "./env";
import type { TenantContext } from "./types";

export interface SessionUser {
  id?: string;
  email?: string;
  name?: string;
}

export interface SessionTenant {
  id: string;
  name?: string;
  slug?: string;
  accounts?: { id: string; slug?: string; name?: string }[];
}

export interface SessionData {
  idToken?: string;
  user?: SessionUser;
  tenants?: SessionTenant[];
  // active workspace context
  tenantId?: string;
  accountId?: string;
}

export function sessionOptions(): SessionOptions {
  return {
    password: env.sessionSecret,
    cookieName: env.sessionCookieName,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 8, // 8h
    },
  };
}

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions());
}

/** Returns the authenticated tenant context, or null if not fully logged in
 *  (also null when auth isn't configured, so callers never hit iron-session). */
export async function getTenantContext(): Promise<TenantContext | null> {
  if (!isAuthConfigured()) return null;
  const s = await getSession();
  if (!s.idToken || !s.tenantId || !s.accountId) return null;
  return { idToken: s.idToken, tenantId: s.tenantId, accountId: s.accountId };
}
