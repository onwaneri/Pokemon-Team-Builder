/**
 * Tiered persistent cache for derived, format-wide server data.
 *
 * Two tiers. L1 is an in-process `Map`: sub-millisecond, private to one lambda instance, gone on
 * cold start. L2 is Firestore (`cache/{namespace}/entries/{hash}`) written as the service account,
 * so a value survives cold starts, is shared across instances, and outlives a deploy. Reads check
 * L1, then L2, then the loader; a value produced by the loader populates both.
 *
 * WITHOUT FIREBASE_ADMIN_* THERE IS NO L2. `firestoreRest()` returns null, every call degrades to
 * L1-only, and `cacheReport().backend` reports `'memory'`. That is the local-development story and
 * it is not a global cache: nothing is shared between processes and nothing survives a restart.
 * Single-flight, TTL, negative caching, and stale-while-revalidate all still work, in-process.
 * Same deal as src/lib/ai/quota.ts, and stated here rather than papered over.
 *
 * What it guarantees:
 *   - Keys are namespaced AND schema-versioned. `version` is part of both the L1 key and the L2
 *     document id, so bumping it when a parser or engine changes shape makes every old entry
 *     unreachable in the same instant, and stale-shaped JSON can never be handed to newly typed
 *     code. Old L2 documents become orphans; they carry an expiry and `purgePersisted` sweeps them.
 *   - Per-entry TTL. A success and a negative result get different lifetimes (see `negativeTtlMs`):
 *     a 404, an unpublished format, or a parse failure is re-probed in minutes, never held for the
 *     success TTL. Deterministic output can declare `ttlMs: Infinity` and is then never re-derived.
 *   - Single-flight. Concurrent callers for the same missing key share one loader invocation; the
 *     rest await it. A stale-while-revalidate refresh shares that same flight.
 *   - Non-blocking bookkeeping. L2 writes never delay a response: inside a Next request they are
 *     handed to `after()`, elsewhere they are floated and their failures swallowed. A cache write
 *     failing is not an error the caller should ever see.
 *   - Bounded blast radius. L2 reads are capped at L2_READ_TIMEOUT_MS (a cache must never be
 *     slower than the thing it caches); L2 writes at L2_WRITE_TIMEOUT_MS, the codebase's 10s
 *     upstream convention. A value whose JSON exceeds MAX_L2_BYTES is kept in L1 only: Firestore
 *     caps a document near 1 MiB, and an oversized entry degrades rather than throwing.
 *
 * What it does NOT do: values must be JSON round-trippable (no Map, Set, Date, class instance).
 * L2 hits are parsed and returned as `T` on the strength of the version alone, so the version IS
 * the type contract. Bump it whenever the shape moves.
 *
 * This cache is shared by every visitor. Only format-wide data belongs in it: species, usage,
 * computed matchups. Never key it by uid, email, or anything else user-specific. Nothing here is
 * partitioned by identity, and the app deliberately stores no PII.
 *
 * Server-only, never import into client code.
 */

import { createHash } from 'node:crypto';
import { firestoreRest, docIdFor, type FirestoreRest, type FirestoreFields } from '@/lib/firebase/server';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Firestore root collection, one sub-collection per namespace. Server-owned, never client-readable. */
export const CACHE_COLLECTION = 'cache';

/** A slow cache is worse than no cache, so the L2 read is capped well below the upstream budget. */
const L2_READ_TIMEOUT_MS = 2_500;
/** Writes are off the response path, so they get the codebase's standard 10s ceiling. */
const L2_WRITE_TIMEOUT_MS = 10_000;
/** Firestore caps a document near 1 MiB; leave room for the metadata fields and UTF-8 expansion. */
const MAX_L2_BYTES = 800_000;
/** Past this many live entries the least recently used are dropped, so a warm instance cannot grow forever. */
const L1_MAX_ENTRIES = 2_000;
/** Firestore has no "never expires"; immutable entries get a far-future stamp instead. */
const MAX_L2_LIFETIME_MS = 10 * 365 * DAY_MS;
/** Applied when a loader returns a negative result and the policy does not say otherwise. */
const DEFAULT_NEGATIVE_TTL_MS = 5 * MINUTE_MS;

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,39}$/;

// ---- Policy presets ----

/**
 * Upstream data that genuinely changes: Pikalytics usage, format rankings, format availability.
 * Fresh for 6h, then served stale for another 18h while one background refresh runs, so a user
 * request never blocks on Pikalytics and the data is never more than a day behind. Negative
 * results (unpublished format, 404, parser drift) re-probe after 5 minutes, which is the same
 * deliberate behaviour `src/lib/data/usage.ts` already has for formats Pikalytics has not
 * published yet.
 */
export const LIVE_DATA = {
  ttlMs: 6 * HOUR_MS,
  staleWhileRevalidateMs: 18 * HOUR_MS,
  negativeTtlMs: 5 * MINUTE_MS,
} as const;

/**
 * Output of a pure function of its inputs: damage rolls, threat matrices, computed stats. Keyed by
 * a content hash of every input (see `contentKey`) it can never go stale, because the same input
 * cannot produce a different answer, so it is cached forever and re-derived only when `version`
 * moves (an engine change, a dataset rebuild, a ruleset delta). A null from a pure function is the
 * right answer rather than a failure, so nothing is treated as negative.
 */
export const DETERMINISTIC = {
  ttlMs: Number.POSITIVE_INFINITY,
  isNegative: () => false,
} as const;

// ---- Types ----

export interface CacheOptions<T> {
  /**
   * Schema version of what the loader returns. Bump it whenever the shape changes; every entry
   * written under an older version becomes unreachable immediately.
   */
  version: number;
  /** How long a successful value is served without revalidation. `Infinity` for immutable data. */
  ttlMs: number;
  /** Extra window past `ttlMs` in which the stale value is returned instantly while one refresh runs. */
  staleWhileRevalidateMs?: number;
  /** Lifetime for a negative result. Defaults to 5 minutes; 0 means "do not cache misses at all". */
  negativeTtlMs?: number;
  /** What counts as negative. Defaults to null/undefined. */
  isNegative?: (value: T) => boolean;
  /** Keep this entry out of Firestore (per-instance or known-oversized data). */
  l1Only?: boolean;
  /** Serve an expired entry when the loader throws, rather than propagating. Default true. */
  staleIfError?: boolean;
}

export interface CacheEntry<T> {
  value: T;
  /** Instant after which the value is stale (still usable within the stale-while-revalidate window). */
  freshUntil: number;
  /** Instant after which the value is dropped entirely. */
  expiresAt: number;
  negative: boolean;
}

export interface CacheStats {
  l1Hits: number;
  l2Hits: number;
  staleHits: number;
  misses: number;
  coalesced: number;
  loaderErrors: number;
  negatives: number;
  l2Writes: number;
  l2Errors: number;
  oversized: number;
}

interface CacheRuntime {
  l1: Map<string, CacheEntry<unknown>>;
  inflight: Map<string, Promise<unknown>>;
  db: FirestoreRest | null;
  stats: CacheStats;
}

// Survive HMR module re-evaluation in dev so a warm L1 is not thrown away on every edit.
const g = globalThis as unknown as { __vgcCache?: CacheRuntime };

function runtime(): CacheRuntime {
  if (!g.__vgcCache) {
    g.__vgcCache = {
      l1: new Map(),
      inflight: new Map(),
      db: firestoreRest(),
      stats: {
        l1Hits: 0, l2Hits: 0, staleHits: 0, misses: 0, coalesced: 0,
        loaderErrors: 0, negatives: 0, l2Writes: 0, l2Errors: 0, oversized: 0,
      },
    };
  }
  return g.__vgcCache;
}

// ---- Keys ----

/** L1 key. Raw and prefix-matchable so `purgeLocal('usage')` can work on it. */
function localKey(namespace: string, version: number, key: string): string {
  return `${namespace} v${version} ${key}`;
}

/** Firestore path for an entry. The version is inside the hashed id, so versions never collide. */
export function entryPath(namespace: string, version: number, key: string): string {
  return `${CACHE_COLLECTION}/${namespace}/entries/${docIdFor(localKey(namespace, version, key))}`;
}

function assertNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid cache namespace "${namespace}" (expected lower-case letters, digits and dashes).`);
  }
}

/** Deterministic JSON with object keys sorted, so key order in the input cannot change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj).sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Content hash of a deterministic computation's inputs: the key under which its output can be
 * cached forever. Include everything the result depends on (team, field, ruleset, the usage
 * snapshot a matrix was built from). Anything left out is a correctness bug, not a cache miss.
 */
export function contentKey(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 32);
}

// ---- L1 ----

function l1Get<T>(rt: CacheRuntime, id: string): CacheEntry<T> | undefined {
  const hit = rt.l1.get(id) as CacheEntry<T> | undefined;
  if (!hit) return undefined;
  // Re-insert so Map iteration order doubles as an LRU list.
  rt.l1.delete(id);
  rt.l1.set(id, hit as CacheEntry<unknown>);
  return hit;
}

function l1Set<T>(rt: CacheRuntime, id: string, entry: CacheEntry<T>): void {
  rt.l1.delete(id);
  rt.l1.set(id, entry as CacheEntry<unknown>);
  while (rt.l1.size > L1_MAX_ENTRIES) {
    const oldest = rt.l1.keys().next();
    if (oldest.done) break;
    rt.l1.delete(oldest.value);
  }
}

// ---- L2 ----

function toFields<T>(namespace: string, version: number, key: string, entry: CacheEntry<T>, json: string): FirestoreFields {
  const expiresAt = Math.min(entry.expiresAt, Date.now() + MAX_L2_LIFETIME_MS);
  return {
    ns: { stringValue: namespace },
    key: { stringValue: key.slice(0, 500) },
    version: { integerValue: String(version) },
    negative: { booleanValue: entry.negative },
    storedAt: { integerValue: String(Date.now()) },
    freshUntil: { integerValue: String(Math.min(entry.freshUntil, expiresAt)) },
    expiresAt: { integerValue: String(expiresAt) },
    // Duplicated as a timestamp so a Firestore TTL policy on `expiresAtTs` can collect orphans left
    // behind by a version bump. Nothing in this module depends on that policy existing.
    expiresAtTs: { timestampValue: new Date(expiresAt).toISOString() },
    json: { stringValue: json },
  };
}

async function l2Read<T>(rt: CacheRuntime, namespace: string, version: number, key: string): Promise<CacheEntry<T> | null> {
  if (!rt.db) return null;
  try {
    const fields = await rt.db.getDoc(entryPath(namespace, version, key), AbortSignal.timeout(L2_READ_TIMEOUT_MS));
    if (!fields) return null;
    const expiresAt = Number(fields.expiresAt?.integerValue ?? 0);
    const json = fields.json?.stringValue;
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt || typeof json !== 'string') return null;
    // Wrapped so a legitimately `undefined` value round-trips instead of vanishing.
    const parsed = JSON.parse(json) as { v?: T };
    return {
      value: parsed.v as T,
      freshUntil: Number(fields.freshUntil?.integerValue ?? 0),
      expiresAt,
      negative: fields.negative?.booleanValue === true,
    };
  } catch {
    // A cache read that fails is a miss, never an error the caller sees.
    return null;
  }
}

/** Hand work to Next's `after()` when inside a request, otherwise float it. Never awaited. */
function offResponsePath(task: () => Promise<void>): void {
  const run = () => { void task().catch(() => {}); };
  void import('next/server')
    .then((mod) => { try { mod.after(run); } catch { run(); } })
    .catch(() => { run(); });
}

function l2Write<T>(rt: CacheRuntime, namespace: string, version: number, key: string, entry: CacheEntry<T>): void {
  const db = rt.db;
  if (!db) return;
  let json: string;
  try {
    json = JSON.stringify({ v: entry.value }) ?? '{}';
  } catch {
    return; // Not JSON round-trippable: L1 keeps it, L2 never sees it.
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_L2_BYTES) {
    rt.stats.oversized++;
    return; // Too big for a Firestore document; degrade to L1-only rather than throwing.
  }
  offResponsePath(async () => {
    try {
      await db.setDoc(
        entryPath(namespace, version, key),
        toFields(namespace, version, key, entry, json),
        AbortSignal.timeout(L2_WRITE_TIMEOUT_MS),
      );
      rt.stats.l2Writes++;
    } catch {
      rt.stats.l2Errors++;
    }
  });
}

// ---- Single-flight ----

function singleFlight<T>(rt: CacheRuntime, id: string, work: () => Promise<T>): Promise<T> {
  const existing = rt.inflight.get(id);
  if (existing) {
    rt.stats.coalesced++;
    return existing as Promise<T>;
  }
  const promise = work();
  rt.inflight.set(id, promise as Promise<unknown>);
  void promise.catch(() => {}).finally(() => { rt.inflight.delete(id); });
  return promise;
}

// ---- The wrapper ----

function defaultIsNegative(value: unknown): boolean {
  return value === null || value === undefined;
}

async function runLoader<T>(
  rt: CacheRuntime,
  namespace: string,
  key: string,
  opts: CacheOptions<T>,
  loader: () => Promise<T>,
  previous: CacheEntry<T> | null,
): Promise<T> {
  const id = localKey(namespace, opts.version, key);
  let value: T;
  try {
    value = await loader();
  } catch (err) {
    rt.stats.loaderErrors++;
    // Stale-if-error: an expired answer beats a failed request when we still have one.
    if (previous && opts.staleIfError !== false) return previous.value;
    throw err;
  }

  const negative = (opts.isNegative ?? defaultIsNegative)(value);
  if (negative) rt.stats.negatives++;
  const ttl = negative ? (opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS) : opts.ttlMs;
  if (!(ttl > 0)) return value; // Explicitly uncacheable.

  const swr = negative ? 0 : (opts.staleWhileRevalidateMs ?? 0);
  const now = Date.now();
  const entry: CacheEntry<T> = { value, freshUntil: now + ttl, expiresAt: now + ttl + swr, negative };
  l1Set(rt, id, entry);
  if (!opts.l1Only) l2Write(rt, namespace, opts.version, key, entry);
  return value;
}

/**
 * Read `key` from the cache, or produce it with `loader` and cache the result.
 *
 * Hit, miss, single-flight, negative caching, TTL, stale-while-revalidate, and the Firestore tier
 * are all handled inside, so a call site stays as short as the `Map.get`/`Map.set` pair it
 * replaces. The loader runs at most once per key at a time no matter how many requests arrive
 * together.
 *
 * `key` must identify the value completely within its namespace, and must never carry a uid,
 * email, or anything else user-specific: this cache is shared by every visitor.
 */
export async function cached<T>(
  namespace: string,
  key: string,
  opts: CacheOptions<T>,
  loader: () => Promise<T>,
): Promise<T> {
  assertNamespace(namespace);
  const rt = runtime();
  const id = localKey(namespace, opts.version, key);
  const now = Date.now();

  const local = l1Get<T>(rt, id);
  if (local) {
    if (now < local.freshUntil) {
      rt.stats.l1Hits++;
      return local.value;
    }
    if (now < local.expiresAt) {
      // Stale but usable: answer now, refresh behind the response (one flight for all callers).
      rt.stats.staleHits++;
      void singleFlight(rt, id, () => runLoader(rt, namespace, key, opts, loader, local)).catch(() => {});
      return local.value;
    }
    rt.l1.delete(id);
  }

  return singleFlight(rt, id, async () => {
    // Another flight may have filled L1 between our check above and getting here.
    const raced = l1Get<T>(rt, id);
    if (raced && Date.now() < raced.freshUntil) {
      rt.stats.l1Hits++;
      return raced.value;
    }

    const remote = opts.l1Only ? null : await l2Read<T>(rt, namespace, opts.version, key);
    if (remote) {
      l1Set(rt, id, remote);
      if (Date.now() < remote.freshUntil) {
        rt.stats.l2Hits++;
        return remote.value;
      }
      // Stale in L2 as well: serve it now and refresh once this flight has cleared.
      rt.stats.staleHits++;
      queueMicrotask(() => {
        void singleFlight(rt, id, () => runLoader(rt, namespace, key, opts, loader, remote)).catch(() => {});
      });
      return remote.value;
    }

    rt.stats.misses++;
    return runLoader(rt, namespace, key, opts, loader, local ?? null);
  });
}

// ---- Inspection and invalidation ----

/**
 * The L2 handle this process is using, or null when there is none. Everything that touches
 * Firestore on the cache's behalf goes through here, so the request path and the operational
 * helpers in ./admin can never disagree about whether L2 exists.
 */
export function cacheDb(): FirestoreRest | null {
  return runtime().db;
}

/** Whatever L1 holds for this key right now, without loading anything. Debugging aid. */
export function peek<T>(namespace: string, version: number, key: string): CacheEntry<T> | undefined {
  return runtime().l1.get(localKey(namespace, version, key)) as CacheEntry<T> | undefined;
}

/** Drop one entry from L1 immediately and from L2 off the response path. */
export function invalidate(namespace: string, version: number, key: string): void {
  assertNamespace(namespace);
  const rt = runtime();
  rt.l1.delete(localKey(namespace, version, key));
  const db = rt.db;
  if (!db) return;
  offResponsePath(async () => {
    try {
      await db.deleteDoc(entryPath(namespace, version, key), AbortSignal.timeout(L2_WRITE_TIMEOUT_MS));
    } catch {
      rt.stats.l2Errors++;
    }
  });
}

/** Clear this instance's L1, optionally only one namespace. Returns how many entries went. */
export function purgeLocal(namespace?: string): number {
  const rt = runtime();
  if (!namespace) {
    const n = rt.l1.size;
    rt.l1.clear();
    return n;
  }
  const prefix = `${namespace} `;
  let n = 0;
  for (const k of [...rt.l1.keys()]) {
    if (k.startsWith(prefix)) { rt.l1.delete(k); n++; }
  }
  return n;
}

export interface CacheReport {
  /** `'tiered'` when Firestore is behind L1, `'memory'` when admin credentials are absent. */
  backend: 'tiered' | 'memory';
  l1Entries: number;
  l1Capacity: number;
  inflight: number;
  stats: CacheStats;
  /** Per-namespace L1 entry counts. */
  namespaces: { namespace: string; entries: number; fresh: number; negative: number }[];
}

/** This instance's cache state. L1 and counters only; `listPersisted` in ./admin reads L2. */
export function cacheReport(): CacheReport {
  const rt = runtime();
  const now = Date.now();
  const byNs = new Map<string, { entries: number; fresh: number; negative: number }>();
  for (const [k, entry] of rt.l1) {
    const ns = k.split(' ')[0];
    const row = byNs.get(ns) ?? { entries: 0, fresh: 0, negative: 0 };
    row.entries++;
    if (now < entry.freshUntil) row.fresh++;
    if (entry.negative) row.negative++;
    byNs.set(ns, row);
  }
  return {
    backend: rt.db ? 'tiered' : 'memory',
    l1Entries: rt.l1.size,
    l1Capacity: L1_MAX_ENTRIES,
    inflight: rt.inflight.size,
    stats: { ...rt.stats },
    namespaces: [...byNs].map(([namespace, row]) => ({ namespace, ...row })).sort((a, b) => b.entries - a.entries),
  };
}
