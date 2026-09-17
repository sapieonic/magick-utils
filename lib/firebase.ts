"use client";
// Firebase client auth — only used to obtain a Firebase ID token, which the BFF
// exchanges with magick-master. Lazily initialized; no-ops cleanly when the
// NEXT_PUBLIC_FIREBASE_* config is absent (mock mode / local token-paste testing).

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  signOut as firebaseAuthSignOut,
  signInWithPopup,
  signInWithEmailAndPassword,
  type Auth,
  type User,
} from "firebase/auth";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseConfigured(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId);
}

let _auth: Auth | null = null;
function auth(): Auth {
  if (!isFirebaseConfigured()) throw new Error("Firebase is not configured (NEXT_PUBLIC_FIREBASE_*).");
  const app: FirebaseApp = getApps().length ? getApp() : initializeApp(config);
  _auth ??= getAuth(app);
  return _auth;
}

/** A credential pair as the BFF wants it: the perishable ID token that is
 *  Bearer'd upstream, plus the long-lived refresh token the server stores so it
 *  can mint the next one without a human at a login screen.
 *
 *  Always read `refreshToken` off the live `User` rather than caching the value
 *  seen at sign-in — the SDK replaces it if Google ever rotates it, and a stale
 *  copy is a credential the secure-token endpoint will refuse. */
export interface FirebaseCredential {
  idToken: string;
  refreshToken: string;
}

async function credentialFor(user: User, force = false): Promise<FirebaseCredential> {
  return { idToken: await user.getIdToken(force), refreshToken: user.refreshToken };
}

export async function googleSignIn(): Promise<FirebaseCredential> {
  const cred = await signInWithPopup(auth(), new GoogleAuthProvider());
  return credentialFor(cred.user);
}

export async function emailSignIn(email: string, password: string): Promise<FirebaseCredential> {
  const cred = await signInWithEmailAndPassword(auth(), email, password);
  return credentialFor(cred.user);
}

/** Subscribe to ID-token changes; returns the unsubscribe function.
 *
 *  Registering this matters as much for its side effect as for its callback:
 *  constructing `Auth` is what starts the SDK's own proactive refresh
 *  scheduler. This module used to be imported by `/login` alone, so on every
 *  other screen no `Auth` object existed, nothing re-minted the hour-long ID
 *  token, and the 8h session cookie carried a dead credential for seven of
 *  those hours.
 *
 *  Fires once on registration with the restored user (or null when signed out).
 *  That first call is wanted, not noise: it is what stamps a refresh token onto
 *  sessions established before the cookie had a field to keep one in.
 *
 *  No-ops — returning a no-op unsubscribe — when Firebase is unconfigured, so
 *  mock mode and the token-paste flow never reach the SDK. */
export function watchIdToken(cb: (cred: FirebaseCredential | null) => void): () => void {
  if (!isFirebaseConfigured()) return () => {};
  try {
    return onIdTokenChanged(auth(), (user: User | null) => {
      if (!user) {
        cb(null);
        return;
      }
      credentialFor(user).then(cb, () => cb(null));
    });
  } catch {
    // A malformed config must not take the app shell down with it — the caller
    // is a background refresher, not a login screen.
    return () => {};
  }
}

/** The signed-in user's current credential, or null when Firebase is off, the
 *  SDK has not restored a user yet, or the token could not be obtained.
 *
 *  `getIdToken()` re-mints on its own once the cached token is near expiry,
 *  which is the whole point of the wake path: a laptop that slept through the
 *  SDK's refresh timer fires no `onIdTokenChanged` when it resumes, so the
 *  visibility handler has to ask for the token explicitly to get a fresh one.
 *  `force` bypasses the SDK cache outright; the wake path deliberately doesn't
 *  use it, since a network round trip on every tab focus buys nothing. */
export async function currentIdToken(force = false): Promise<FirebaseCredential | null> {
  if (!isFirebaseConfigured()) return null;
  try {
    const user = auth().currentUser;
    return user ? await credentialFor(user, force) : null;
  } catch {
    return null;
  }
}

/** Sign the Firebase SDK out, clearing the refresh token it keeps in IndexedDB.
 *
 *  Without this, "Sign out" left the browser holding a credential that can mint
 *  new ID tokens indefinitely — so the next person at a shared machine could be
 *  handed a working session by the refresher. No-ops when Firebase is
 *  unconfigured, and never throws: failing to sign out of the SDK must not stop
 *  the server session being destroyed, which is the part that actually matters. */
export async function firebaseSignOut(): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    await firebaseAuthSignOut(auth());
  } catch {
    // Already signed out, or the SDK never initialised on this page.
  }
}
