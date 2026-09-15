/**
 * Which key an AI request runs on, and whether it is allowed to.
 *
 * Two sources, in order:
 *   1. The visitor's own key (BYOK), sealed in an httpOnly cookie. Set by /api/ai-key after a
 *      validation round-trip; AES-256-GCM under AI_COOKIE_SECRET; JavaScript can never read it and
 *      it is never stored server-side. No quota applies.
 *   2. The site's free tier: the owner's key from the environment, tried in the order OpenAI,
 *      Gemini, Anthropic, OpenRouter unless FREE_TIER_PROVIDER forces one. Limited to
 *      FREE_CHAT_LIMIT requests per signed-in Firebase account (a verified ID token is required;
 *      anonymous visitors get a signed device cookie for identity but are asked to sign in or
 *      connect a key). The limit and the running count are never exposed to the browser — the
 *      UI just says to go easy on it.
 * Ambient features (compare chips, blurbs, role inference) only ever use source 1 — they fall back
 * to deterministic behaviour without it — so the free tier is spent only on requests the visitor
 * explicitly triggers (chat, team builder, SP optimizer, benchmark parsing).
 * Server-only.
 */
import { cookies } from 'next/headers';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createLlmClient, isProviderId, keyFingerprint, modelFor, type AiJob, type LlmClient, type LlmCredential, type ProviderId } from '@/lib/ai/llm';
import { verifyIdToken } from '@/lib/firebase/server';
import { quotaStore, FREE_CHAT_LIMIT } from '@/lib/ai/quota';

const KEY_COOKIE = 'vgc_ai_key';
const DEVICE_COOKIE = 'vgc_device';
const KEY_COOKIE_DAYS = 90;
const DEVICE_COOKIE_DAYS = 365;

// ─── Secret ───────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __vgcCookieSecret?: Buffer };
function secret(): Buffer {
  if (!g.__vgcCookieSecret) {
    const env = process.env.AI_COOKIE_SECRET;
    if (env && env.length >= 16) g.__vgcCookieSecret = scryptSync(env, 'vgc-ai-cookie', 32);
    else {
      console.warn('[ai] AI_COOKIE_SECRET is not set — using a per-process secret, so connected keys and device ids reset on restart. Set a long random value in .env.local.');
      g.__vgcCookieSecret = randomBytes(32);
    }
  }
  return g.__vgcCookieSecret;
}

function seal(payload: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64url');
}

function unseal<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    const buf = Buffer.from(value, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', secret(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}
function verifySigned(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const value = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(value);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

const isProd = process.env.NODE_ENV === 'production';

// ─── BYOK cookie ──────────────────────────────────────────────────────────────

interface SealedKey {
  provider: ProviderId;
  apiKey: string;
}

export async function readByok(): Promise<LlmCredential | null> {
  const store = await cookies();
  const parsed = unseal<SealedKey>(store.get(KEY_COOKIE)?.value);
  if (!parsed || !isProviderId(parsed.provider) || typeof parsed.apiKey !== 'string' || !parsed.apiKey) return null;
  return { provider: parsed.provider, apiKey: parsed.apiKey };
}

export async function writeByok(cred: LlmCredential): Promise<void> {
  const store = await cookies();
  store.set(KEY_COOKIE, seal({ provider: cred.provider, apiKey: cred.apiKey }), {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api',
    maxAge: KEY_COOKIE_DAYS * 24 * 3600,
  });
}

export async function clearByok(): Promise<void> {
  const store = await cookies();
  store.set(KEY_COOKIE, '', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api', maxAge: 0 });
}

// ─── Identity ─────────────────────────────────────────────────────────────────

export interface Identity {
  /** "uid:<firebase uid>" or "anon:<device id>". */
  id: string;
  kind: 'account' | 'device';
}

/**
 * Firebase uid when the request carries a valid ID token; otherwise the signed device cookie
 * (created on first sight — the cookie API lets a Route Handler set it while reading it).
 */
export async function resolveIdentity(req: Request): Promise<Identity> {
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const verified = await verifyIdToken(bearer);
  if (verified) return { id: `uid:${verified.uid}`, kind: 'account' };

  const store = await cookies();
  const existing = verifySigned(store.get(DEVICE_COOKIE)?.value);
  if (existing) return { id: `anon:${existing}`, kind: 'device' };
  const fresh = randomBytes(16).toString('base64url');
  store.set(DEVICE_COOKIE, `${fresh}.${sign(fresh)}`, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_DAYS * 24 * 3600,
  });
  return { id: `anon:${fresh}`, kind: 'device' };
}

// ─── Free tier ────────────────────────────────────────────────────────────────

function freeTierCredential(): LlmCredential | null {
  const forced = process.env.FREE_TIER_PROVIDER;
  const candidates: { provider: ProviderId; key?: string }[] = [
    { provider: 'openai', key: process.env.OPENAI_API_KEY },
    { provider: 'gemini', key: process.env.GEMINI_API_KEY },
    { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY },
    { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY },
  ];
  const ordered = isProviderId(forced) ? [...candidates.filter((c) => c.provider === forced), ...candidates.filter((c) => c.provider !== forced)] : candidates;
  const hit = ordered.find((c) => c.key);
  return hit ? { provider: hit.provider, apiKey: hit.key! } : null;
}

export type AiSource = 'byok' | 'free';

export interface AiGrant {
  /** Client bound to the model this job runs on (see modelFor in llm.ts). */
  client: LlmClient;
  source: AiSource;
  /** Undo the free-tier charge when the upstream call failed outright. */
  refund: () => Promise<void>;
  /** Headers the route should attach so the UI can show the counter. */
  headers: Record<string, string>;
}

export type AiDenialCode = 'no_key' | 'sign_in_required' | 'quota_exhausted' | 'free_tier_unavailable';

export class AiDenied extends Error {
  constructor(public code: AiDenialCode, message: string) {
    super(message);
    this.name = 'AiDenied';
  }
}

/**
 * Resolve the client for an AI request. The visitor only ever chooses a provider; the model is
 * picked here from the job (chat and builds on the provider's smart tier, structured one-shot
 * jobs on its fast tier).
 *   interactive=true  → BYOK, else the free tier (counted per visitor: the Firebase account when
 *                       signed in, otherwise the signed device cookie), else AiDenied.
 *   interactive=false → BYOK only; returns null so the caller uses its deterministic fallback.
 */
export async function resolveAi(req: Request, opts: { job: AiJob; interactive: true; consume?: boolean }): Promise<AiGrant>;
export async function resolveAi(req: Request, opts: { job: AiJob; interactive: false }): Promise<AiGrant | null>;
export async function resolveAi(req: Request, opts: { job: AiJob; interactive: boolean; consume?: boolean }): Promise<AiGrant | null> {
  const byok = await readByok();
  if (byok) {
    const model = modelFor(byok.provider, opts.job);
    return {
      client: createLlmClient({ ...byok, model }),
      source: 'byok',
      refund: async () => {},
      headers: { 'X-AI-Source': 'byok', 'X-AI-Provider': byok.provider, 'X-AI-Model': model },
    };
  }
  if (!opts.interactive) return null;

  const free = freeTierCredential();
  if (!free) {
    throw new AiDenied('free_tier_unavailable', 'The free tier is not configured on this server. Connect your own API key to use AI features.');
  }
  // No sign-in needed: an anonymous visitor's allowance follows the device cookie, a signed-in
  // visitor's follows the account. Both stay hidden; the only visible edge is the denial.
  const identity = await resolveIdentity(req);
  const quota = quotaStore();
  // consume:false = a continuation of a request that was already charged (multi-step team build).
  if (opts.consume !== false) {
    const used = await quota.used(identity.id);
    if (used >= FREE_CHAT_LIMIT) {
      throw new AiDenied('quota_exhausted', "That's all the built-in AI I can cover for you :) Add one of your own API keys to keep going — it stays on this device and is never stored on the server.");
    }
    await quota.consume(identity.id);
  }
  const model = modelFor(free.provider, opts.job);
  return {
    client: createLlmClient({ ...free, model }),
    source: 'free',
    refund: () => quota.refund(identity.id),
    headers: { 'X-AI-Source': 'free', 'X-AI-Provider': free.provider, 'X-AI-Model': model },
  };
}

// ─── Signed opaque state (multi-step requests) ────────────────────────────────

/** Serialize server state the client will hand back later; the HMAC stops tampering. */
export function sealState(state: unknown): string {
  const body = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function openState<T>(token: unknown): T | null {
  if (typeof token !== 'string') return null;
  const body = verifySigned(token);
  if (!body) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** What the key panel shows. No numbers: the limit and the count stay on the server. */
export async function aiStatus(req: Request): Promise<{
  byok: { provider: ProviderId; fingerprint: string } | null;
  free: { configured: boolean; signedIn: boolean; exhausted: boolean };
  store: 'firestore' | 'memory';
}> {
  const byok = await readByok();
  const identity = await resolveIdentity(req);
  const free = freeTierCredential();
  const store = quotaStore();
  const exhausted = free ? (await store.used(identity.id)) >= FREE_CHAT_LIMIT : false;
  return {
    byok: byok ? { provider: byok.provider, fingerprint: keyFingerprint(byok.apiKey) } : null,
    free: { configured: !!free, signedIn: identity.kind === 'account', exhausted },
    store: store.kind,
  };
}

/** Standard JSON error for a denial, so every AI route answers the same way. */
export function denialResponse(e: AiDenied): Response {
  return Response.json({ error: e.message, code: e.code }, { status: 402 });
}
