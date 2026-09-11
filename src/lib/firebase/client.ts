'use client';

/**
 * Firebase client SDK bootstrap (browser only).
 *
 * Config comes from NEXT_PUBLIC_FIREBASE_* (see .env.example); those values are the public web
 * app config, safe to ship to the browser — access is governed by Firebase Auth + Firestore
 * Security Rules, not by hiding them. When the config is absent (a fresh clone with no .env.local)
 * everything stays in guest mode: `firebaseApp()` returns null and the app keeps using
 * localStorage for teams.
 */
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** True when the public web config is present. */
export const firebaseConfigured = !!(config.apiKey && config.projectId && config.appId);

export function firebaseApp(): FirebaseApp | null {
  if (!firebaseConfigured || typeof window === 'undefined') return null;
  return getApps().length ? getApp() : initializeApp(config);
}

export function firebaseAuth(): Auth | null {
  const app = firebaseApp();
  return app ? getAuth(app) : null;
}

export function firestoreDb(): Firestore | null {
  const app = firebaseApp();
  return app ? getFirestore(app) : null;
}
