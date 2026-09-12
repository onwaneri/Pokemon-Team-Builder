/**
 * Operational view of the persistent cache: list what is in Firestore, and delete it.
 *
 * Everything here talks to L2 directly and awaits the result, so it is the opposite of the request
 * path in ./persistent. Nothing in this file belongs in a user-facing request: `listPersisted` and
 * `purgePersisted` page through a whole namespace and cost one Firestore read per page plus one
 * delete per document. Use them from a script, a one-off route you remove again, or a `node -e`.
 *
 * Without FIREBASE_ADMIN_* there is no L2 to inspect and every function here reports zero, which is
 * correct rather than an error: in that configuration the cache is L1-only and `cacheReport()` in
 * ./persistent is the whole picture.
 *
 * Deleting an entry is always safe. The cache is derived data by construction: a purged key is
 * recomputed on next access. Purging is the blunt instrument; bumping a namespace's `version` is
 * the surgical one, because it strands old entries instead of racing live readers.
 *
 * Server-only, never import into client code.
 */

import { CACHE_COLLECTION, cacheDb, purgeLocal, cacheReport, type CacheReport } from '@/lib/cache/persistent';

/** One L2 entry as stored, without its payload. */
export interface PersistedEntryInfo {
  /** Firestore document id (the hashed namespace/version/key triple). */
  id: string;
  namespace: string;
  /** The original cache key, truncated to 500 characters when it was written. */
  key: string;
  version: number;
  negative: boolean;
  storedAt: number;
  freshUntil: number;
  expiresAt: number;
  /** True when `expiresAt` has passed: the entry is dead weight and safe to sweep. */
  expired: boolean;
}

const LIST_PAGE_SIZE = 300;
const ADMIN_TIMEOUT_MS = 10_000;
/** Metadata only. The payload is deliberately never pulled: a page of it can be hundreds of MB. */
const INFO_FIELDS = ['ns', 'key', 'version', 'negative', 'storedAt', 'freshUntil', 'expiresAt'];

function collectionPath(namespace: string): string {
  return `${CACHE_COLLECTION}/${namespace}/entries`;
}

/**
 * Every L2 entry in a namespace, newest write first. `limit` caps the scan; raise it knowing each
 * page is a Firestore read. Empty when admin credentials are absent.
 */
export async function listPersisted(namespace: string, limit = 1_000): Promise<PersistedEntryInfo[]> {
  const db = cacheDb();
  if (!db) return [];
  const now = Date.now();
  const out: PersistedEntryInfo[] = [];
  let pageToken: string | undefined;
  do {
    const page = await db.listDocs(collectionPath(namespace), {
      pageSize: Math.min(LIST_PAGE_SIZE, limit - out.length),
      ...(pageToken ? { pageToken } : {}),
      fieldMask: INFO_FIELDS,
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
    for (const doc of page.docs) {
      const expiresAt = Number(doc.fields.expiresAt?.integerValue ?? 0);
      out.push({
        id: doc.id,
        namespace: doc.fields.ns?.stringValue ?? namespace,
        key: doc.fields.key?.stringValue ?? '',
        version: Number(doc.fields.version?.integerValue ?? 0),
        negative: doc.fields.negative?.booleanValue === true,
        storedAt: Number(doc.fields.storedAt?.integerValue ?? 0),
        freshUntil: Number(doc.fields.freshUntil?.integerValue ?? 0),
        expiresAt,
        expired: !expiresAt || now >= expiresAt,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < limit);
  return out.sort((a, b) => b.storedAt - a.storedAt).slice(0, limit);
}

export interface PurgeResult {
  scanned: number;
  deleted: number;
  /** Entries left in place because a filter excluded them. */
  kept: number;
}

/**
 * Delete L2 entries in a namespace. By default everything; `expiredOnly` sweeps only dead entries,
 * `olderThanVersion` strands whatever an earlier version left behind. Deletes run serially so a
 * sweep cannot flood Firestore. This does not touch other instances' L1: their entries age out on
 * their own TTL, which is the price of a two-tier cache and why a version bump is usually better.
 */
export async function purgePersisted(
  namespace: string,
  opts: { expiredOnly?: boolean; olderThanVersion?: number; limit?: number } = {},
): Promise<PurgeResult> {
  const db = cacheDb();
  if (!db) return { scanned: 0, deleted: 0, kept: 0 };
  const entries = await listPersisted(namespace, opts.limit ?? 5_000);
  let deleted = 0;
  let kept = 0;
  for (const entry of entries) {
    const doomed = (!opts.expiredOnly || entry.expired)
      && (opts.olderThanVersion === undefined || entry.version < opts.olderThanVersion);
    if (!doomed) { kept++; continue; }
    try {
      await db.deleteDoc(`${collectionPath(namespace)}/${entry.id}`, AbortSignal.timeout(ADMIN_TIMEOUT_MS));
      deleted++;
    } catch {
      kept++;
    }
  }
  return { scanned: entries.length, deleted, kept };
}

export interface NamespaceSummary {
  namespace: string;
  entries: number;
  fresh: number;
  stale: number;
  expired: number;
  negative: number;
  versions: number[];
  newestWrite: number;
}

/** Counts for a namespace's L2 contents, for answering "is this cache doing anything". */
export async function summarizePersisted(namespace: string, limit = 5_000): Promise<NamespaceSummary> {
  const entries = await listPersisted(namespace, limit);
  const now = Date.now();
  return {
    namespace,
    entries: entries.length,
    fresh: entries.filter((e) => now < e.freshUntil).length,
    stale: entries.filter((e) => now >= e.freshUntil && !e.expired).length,
    expired: entries.filter((e) => e.expired).length,
    negative: entries.filter((e) => e.negative).length,
    versions: [...new Set(entries.map((e) => e.version))].sort((a, b) => a - b),
    newestWrite: entries.reduce((max, e) => Math.max(max, e.storedAt), 0),
  };
}

/** Local report plus L2 summaries for the namespaces asked about. One call for an ops check. */
export async function inspectCache(namespaces: string[] = []): Promise<{ local: CacheReport; persisted: NamespaceSummary[] }> {
  return {
    local: cacheReport(),
    persisted: await Promise.all(namespaces.map((ns) => summarizePersisted(ns))),
  };
}

/** Drop a namespace from both tiers of this instance. Returns what each tier gave up. */
export async function purgeNamespace(namespace: string): Promise<{ local: number; persisted: PurgeResult }> {
  return { local: purgeLocal(namespace), persisted: await purgePersisted(namespace) };
}
