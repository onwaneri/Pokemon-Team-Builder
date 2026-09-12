/**
 * Server-side Firebase helpers with zero extra dependencies.
 *
 * Two things the AI quota needs from Firebase, both done against Google's public HTTP APIs with
 * Node's crypto so the (large) firebase-admin package stays out of the bundle:
 *   - `verifyIdToken`: check a Firebase Auth ID token the browser sent (RS256 against Google's
 *     published certificates, plus the audience/issuer/expiry claims Firebase documents).
 *   - `firestoreRest`: minimal Firestore REST access authenticated as the service account in
 *     FIREBASE_ADMIN_* (JWT bearer grant → OAuth access token, cached until shortly before expiry).
 *     Reads (`getDoc`, `listDocs`) and writes (`setDoc`, `deleteDoc`, `incrementField`) only — no
 *     queries, transactions, or listeners. Service-account calls bypass `firestore.rules`
 *     entirely, so every collection reached from here is server-owned by construction.
 * Both degrade cleanly: without NEXT_PUBLIC_FIREBASE_PROJECT_ID tokens are treated as absent, and
 * without admin credentials `firestoreRest` is null (the quota store falls back to memory and the
 * persistent cache to L1-only).
 * Server-only.
 */
import { createHash, createPublicKey, createSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_ADMIN_PROJECT_ID || '';

// ─── ID token verification ─────────────────────────────────────────────────────

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache: { keys: Record<string, KeyObject>; expires: number } | null = null;

async function googleCerts(): Promise<Record<string, KeyObject>> {
  if (certCache && Date.now() < certCache.expires) return certCache.keys;
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
    const keys = await googleCerts();
    const key = keys[header.kid];
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

/** The subset of Firestore's JSON value union this client reads and writes. */
export interface FirestoreValue {
  integerValue?: string;
  stringValue?: string;
  booleanValue?: boolean;
  doubleValue?: number;
  timestampValue?: string;
  nullValue?: null;
}

export type FirestoreFields = Record<string, FirestoreValue>;

export interface FirestoreDoc {
  /** Last segment of the document path. */
  id: string;
  fields: FirestoreFields;
}

export interface FirestoreRest {
  /** Read one document's fields (raw Firestore value objects) or null when absent. */
  getDoc(path: string, signal?: AbortSignal): Promise<FirestoreFields | null>;
  /** Atomically add `by` to an integer field, creating the document if needed; returns the new value. */
  incrementField(path: string, field: string, by: number): Promise<number>;
  /**
   * Create the document or overwrite exactly the fields given (set semantics for those fields;
   * any field absent from `fields` is left alone, so callers that want a clean document write the
   * whole field set every time). Firestore caps a document at roughly 1 MiB — oversized writes are
   * rejected by the server, not by this client.
   */
  setDoc(path: string, fields: FirestoreFields, signal?: AbortSignal): Promise<void>;
  /** Delete one document. Deleting a document that does not exist succeeds. */
  deleteDoc(path: string, signal?: AbortSignal): Promise<void>;
  /**
   * One page of a collection's documents. `fieldMask` limits what comes back over the wire;
   * page with `nextPageToken` until it is undefined.
   */
  listDocs(
    collectionPath: string,
    opts?: { pageSize?: number; pageToken?: string; fieldMask?: string[]; signal?: AbortSignal },
  ): Promise<{ docs: FirestoreDoc[]; nextPageToken?: string }>;
}

export function firestoreRest(): FirestoreRest | null {
  if (!firestoreAdminConfigured) return null;
  const base = `https://firestore.googleapis.com/v1/projects/${ADMIN.projectId}/databases/(default)/documents`;
  const fullName = (path: string) => `projects/${ADMIN.projectId}/databases/(default)/documents/${path}`;
  return {
    async getDoc(path, signal) {
      const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` }, ...(signal ? { signal } : {}) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Firestore read failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { fields?: FirestoreFields };
      return json.fields ?? {};
    },
    async setDoc(path, fields, signal) {
      // updateMask pins the write to exactly the fields supplied, so the call means the same thing
      // whether or not the document already exists.
      const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
      const res = await fetch(`${base}/${path}${mask ? `?${mask}` : ''}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`Firestore write failed (HTTP ${res.status}).`);
    },
    async deleteDoc(path, signal) {
      const res = await fetch(`${base}/${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await accessToken()}` },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Firestore delete failed (HTTP ${res.status}).`);
    },
    async listDocs(collectionPath, opts = {}) {
      const params = new URLSearchParams();
      if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
      if (opts.pageToken) params.set('pageToken', opts.pageToken);
      for (const f of opts.fieldMask ?? []) params.append('mask.fieldPaths', f);
      const qs = params.toString();
      const res = await fetch(`${base}/${collectionPath}${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 404) return { docs: [] };
      if (!res.ok) throw new Error(`Firestore list failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { documents?: { name?: string; fields?: FirestoreFields }[]; nextPageToken?: string };
      const docs = (json.documents ?? []).map((d) => ({ id: (d.name ?? '').split('/').pop() ?? '', fields: d.fields ?? {} }));
      return { docs, ...(json.nextPageToken ? { nextPageToken: json.nextPageToken } : {}) };
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
