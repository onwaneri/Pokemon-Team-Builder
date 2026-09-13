/**
 * Server-side Firebase helpers with zero extra dependencies.
 *
 * Two things the AI quota needs from Firebase, both done against Google's public HTTP APIs with
 * Node's crypto so the (large) firebase-admin package stays out of the bundle:
 *   - `verifyIdToken`: check a Firebase Auth ID token the browser sent (RS256 against Google's
 *     published certificates, plus the audience/issuer/expiry claims Firebase documents).
 *   - `firestoreRest`: minimal Firestore REST access authenticated as the service account in
 *     FIREBASE_ADMIN_* (JWT bearer grant → OAuth access token, cached until shortly before expiry).
 * Both degrade cleanly: without NEXT_PUBLIC_FIREBASE_PROJECT_ID tokens are treated as absent, and
 * without admin credentials `firestoreRest` is null (the quota store falls back to memory).
 * Server-only.
 */
import { createHash, createPublicKey, createSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_ADMIN_PROJECT_ID || '';

// ─── ID token verification ─────────────────────────────────────────────────────

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache: { keys: Record<string, KeyObject>; expires: number } | null = null;

async function googleCerts(force = false): Promise<Record<string, KeyObject>> {
  if (!force && certCache && Date.now() < certCache.expires) return certCache.keys;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error(`Could not fetch Google certificates (HTTP ${res.status}).`);
  const pems = (await res.json()) as Record<string, string>;
  const keys = Object.fromEntries(Object.entries(pems).map(([kid, pem]) => [kid, createPublicKey(pem)]));
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  certCache = { keys, expires: Date.now() + Math.max(60, maxAge - 60) * 1000 };
  return keys;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface VerifiedIdToken {
  uid: string;
  email?: string;
}

/** Returns the uid for a valid Firebase ID token, or null when the token is missing/invalid/unconfigured. */
export async function verifyIdToken(token: string | null | undefined): Promise<VerifiedIdToken | null> {
  if (!token || !PROJECT_ID) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
    const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'RS256' || !header.kid) return null;
    // Google rotates signing keys inside the cert set's max-age (~6 h), so a warm serverless
    // instance can hold a set that predates the key a fresh token was signed with. One forced
    // refetch on an unknown kid keeps sign-in working across rotations.
    let key = (await googleCerts())[header.kid];
    if (!key) key = (await googleCerts(true))[header.kid];
    if (!key) return null;
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64urlDecode(parts[2]));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 300) return null;
    return { uid: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
  } catch {
    return null;
  }
}

// ─── Firestore REST as the service account ────────────────────────────────────

const ADMIN = {
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID || PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL || '',
  privateKey: (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

export const firestoreAdminConfigured = !!(ADMIN.projectId && ADMIN.clientEmail && ADMIN.privateKey);

let tokenCache: { token: string; expires: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: ADMIN.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(ADMIN.privateKey))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Firebase service-account auth failed: ${json.error_description ?? json.error ?? res.status}`);
  tokenCache = { token: json.access_token, expires: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000 };
  return json.access_token;
}

export interface FirestoreRest {
  /** Read one document's fields (raw Firestore value objects) or null when absent. */
  getDoc(path: string): Promise<Record<string, { integerValue?: string; stringValue?: string }> | null>;
  /** Atomically add `by` to an integer field, creating the document if needed; returns the new value. */
  incrementField(path: string, field: string, by: number): Promise<number>;
}

export function firestoreRest(): FirestoreRest | null {
  if (!firestoreAdminConfigured) return null;
  const base = `https://firestore.googleapis.com/v1/projects/${ADMIN.projectId}/databases/(default)/documents`;
  const fullName = (path: string) => `projects/${ADMIN.projectId}/databases/(default)/documents/${path}`;
  return {
    async getDoc(path) {
      const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Firestore read failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { fields?: Record<string, { integerValue?: string; stringValue?: string }> };
      return json.fields ?? {};
    },
    async incrementField(path, field, by) {
      const res = await fetch(`${base}:commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          writes: [{ transform: { document: fullName(path), fieldTransforms: [{ fieldPath: field, increment: { integerValue: String(by) } }] } }],
        }),
      });
      if (!res.ok) throw new Error(`Firestore write failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { writeResults?: { transformResults?: { integerValue?: string }[] }[] };
      return Number(json.writeResults?.[0]?.transformResults?.[0]?.integerValue ?? NaN);
    },
  };
}

/** Stable, path-safe document id for an identity string like "uid:abc" or "anon:xyz". */
export function docIdFor(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 40);
}
