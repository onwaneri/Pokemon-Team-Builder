/**
 * Free-tier usage counter: how many AI requests each signed-in user has made on the site's own key.
 * The limit is deliberately never sent to the browser.
 *
 * Backed by Firestore (collection `aiQuota`, one document per identity hash, field `used`) when the
 * service-account env is present, so the count survives deploys and is shared across instances.
 * Otherwise an in-process map, which is fine for local development and honest about its limits.
 * Server-only.
 */
import { firestoreRest, docIdFor } from '@/lib/firebase/server';

export const FREE_CHAT_LIMIT = Math.max(0, Number(process.env.FREE_CHAT_LIMIT ?? 15) || 15);

export interface QuotaStore {
  kind: 'firestore' | 'memory';
  used(identity: string): Promise<number>;
  /** Consume one request; returns the count after consuming. */
  consume(identity: string): Promise<number>;
  /** Give one back (the upstream call failed before producing anything). */
  refund(identity: string): Promise<void>;
}

class MemoryQuota implements QuotaStore {
  kind = 'memory' as const;
  private counts = new Map<string, number>();
  async used(id: string) { return this.counts.get(id) ?? 0; }
  async consume(id: string) { const n = (this.counts.get(id) ?? 0) + 1; this.counts.set(id, n); return n; }
  async refund(id: string) { this.counts.set(id, Math.max(0, (this.counts.get(id) ?? 0) - 1)); }
}

class FirestoreQuota implements QuotaStore {
  kind = 'firestore' as const;
  constructor(private readonly db: NonNullable<ReturnType<typeof firestoreRest>>) {}
  private path(id: string) { return `aiQuota/${docIdFor(id)}`; }
  async used(id: string) {
    const doc = await this.db.getDoc(this.path(id));
    return Number(doc?.used?.integerValue ?? 0);
  }
  async consume(id: string) { return this.db.incrementField(this.path(id), 'used', 1); }
  async refund(id: string) { await this.db.incrementField(this.path(id), 'used', -1); }
}

// Survive HMR module re-evaluation in dev so the memory counter is not reset on every edit.
const g = globalThis as unknown as { __vgcQuota?: QuotaStore };

export function quotaStore(): QuotaStore {
  if (!g.__vgcQuota) {
    const db = firestoreRest();
    g.__vgcQuota = db ? new FirestoreQuota(db) : new MemoryQuota();
  }
  return g.__vgcQuota;
}
