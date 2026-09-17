"use client";
// Keeps the BFF session cookie's Firebase credential alive while the app shell
// is open. Renders nothing.
//
// The failure this exists to prevent: a Firebase ID token lives one hour, the
// session cookie eight, and `lib/firebase.ts` used to be imported by /login
// alone — so once a user navigated into the app no `Auth` object existed, the
// SDK's proactive refresh scheduler never ran, and for seven of every eight
// hours the cookie carried a dead credential that bounced people to /login
// mid-session. Mounting this in the app-shell layout both restarts that
// scheduler and forwards every token it mints to the server.

import { useEffect, useEffectEvent, useRef } from "react";
import { backendStatus, postRefresh } from "@/lib/api";
import { currentIdToken, isFirebaseConfigured, watchIdToken, type FirebaseCredential } from "@/lib/firebase";

export function SessionRefresher() {
  // Survives the effect being torn down and re-run (React 19 cleans up Effects
  // in a hidden <Activity> subtree), so coming back to a backgrounded tab
  // doesn't re-POST a token the server already has.
  const deliveredToken = useRef("");

  // An Effect Event, so the subscription below is registered exactly once and
  // never re-subscribes to track changing values — losing the subscription is
  // the very failure this component prevents.
  const handoff = useEffectEvent(async (cred: FirebaseCredential | null) => {
    // A null credential means signed out; the app-shell guard handles that
    // through /api/auth/me. There is nothing to hand over.
    if (!cred || cred.idToken === deliveredToken.current) return;
    deliveredToken.current = cred.idToken;
    const ok = await postRefresh(cred.idToken, cred.refreshToken).catch(() => false);
    // Only a delivered token may be remembered as delivered. Marking a failed
    // hand-off as done would make the next wake skip it and leave the cookie on
    // the dead credential until the user is bounced.
    if (!ok) deliveredToken.current = "";
  });

  useEffect(() => {
    // Mock mode and the local token-paste flow have no Firebase and no session
    // to refresh — both must stay untouched.
    if (!isFirebaseConfigured()) return;

    let alive = true;
    let unwatch: (() => void) | null = null;

    // Timers do not run while a laptop sleeps, so a tab left open past the
    // token's hour wakes with a dead credential and no `onIdTokenChanged` to
    // announce it. Asking for the token on resume makes that path deterministic:
    // `getIdToken()` re-mints by itself when the cached one is near expiry.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      void currentIdToken().then((cred) => {
        if (alive) void handoff(cred);
      });
    };

    (async () => {
      // `backendStatus()` throws rather than guessing when /api/health can't be
      // reached — a network blip must not be read as "demo mode".
      const backend = await backendStatus().then((s) => s.backend, () => false);
      if (!alive || !backend) return;
      unwatch = watchIdToken((cred) => {
        void handoff(cred);
      });
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("focus", wake);
    })();

    return () => {
      alive = false;
      unwatch?.();
      // Symmetric with the async registration above: removing a listener that
      // was never added is a no-op, and leaving one attached after unmount would
      // keep POSTing from a component that no longer exists.
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  return null;
}
