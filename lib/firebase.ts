"use client";
// Firebase client auth — only used to obtain a Firebase ID token, which the BFF
// exchanges with magick-master. Lazily initialized; no-ops cleanly when the
// NEXT_PUBLIC_FIREBASE_* config is absent (mock mode / local token-paste testing).

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  type Auth,
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

export async function googleSignIn(): Promise<string> {
  const cred = await signInWithPopup(auth(), new GoogleAuthProvider());
  return cred.user.getIdToken();
}

export async function emailSignIn(email: string, password: string): Promise<string> {
  const cred = await signInWithEmailAndPassword(auth(), email, password);
  return cred.user.getIdToken();
}
