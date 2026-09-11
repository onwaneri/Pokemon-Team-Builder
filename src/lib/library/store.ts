/**
 * Team library storage adapter.
 *
 * The TeamStore interface is deliberately async even though the current localStorage
 * implementation is synchronous. This makes it trivial to swap in a Firestore (or any
 * other remote) adapter later without touching any callsites — just replace the export.
 *
 * The teamHash() helper produces a stable fingerprint of the slot composition that is
 * independent of cosmetic fields (nickname, role, benchmarks). It is used to detect
 * when a saved blurb is stale and needs to be regenerated.
 */
import type { TeamMon } from '@/lib/benchmarks/types';
import type { SavedTeam } from './types';

// ─── Async store interface ─────────────────────────────────────────────────────

export interface TeamStore {
  list(): Promise<SavedTeam[]>;
  get(id: string): Promise<SavedTeam | null>;
  save(team: SavedTeam): Promise<void>;
  remove(id: string): Promise<void>;
}

// ─── localStorage implementation ──────────────────────────────────────────────

const STORAGE_KEY = 'vgc-champions-teams-v1';

function readAll(): SavedTeam[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedTeam[];
  } catch (err) {
    console.warn('[TeamStore] Corrupt localStorage data — treating as empty.', err);
    return [];
  }
}

function writeAll(teams: SavedTeam[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(teams));
  } catch (err) {
    console.warn('[TeamStore] Failed to write to localStorage.', err);
  }
}

class LocalStorageTeamStore implements TeamStore {
  async list(): Promise<SavedTeam[]> {
    return readAll();
  }

  async get(id: string): Promise<SavedTeam | null> {
    return readAll().find((t) => t.id === id) ?? null;
  }

  async save(team: SavedTeam): Promise<void> {
    if (typeof window === 'undefined') return;
    const all = readAll();
    const idx = all.findIndex((t) => t.id === team.id);
    if (idx >= 0) {
      all[idx] = team;
    } else {
      all.push(team);
    }
    writeAll(all);
  }

  async remove(id: string): Promise<void> {
    if (typeof window === 'undefined') return;
    writeAll(readAll().filter((t) => t.id !== id));
  }
}

export const teamStore: TeamStore = new LocalStorageTeamStore();

// ─── Team hash ────────────────────────────────────────────────────────────────

/**
 * Canonical fingerprint of a 6-slot composition.
 *
 * Only fields that materially affect gameplay (and therefore the blurb) are included:
 * species, ability, item, nature, sorted moves, and SP spread. Cosmetic fields —
 * nickname, role, benchmarks, computedStats — are intentionally excluded so that
 * renaming a mon or updating benchmarks does not invalidate the blurb.
 *
 * Null slots are preserved so that adding a mon to an empty slot changes the hash.
 */
export function teamHash(team: (TeamMon | null)[]): string {
  const canonical = team.map((mon) => {
    if (mon === null) return null;
    return [
      mon.species,
      mon.ability ?? '',
      mon.item ?? '',
      mon.nature,
      [...mon.moves].sort(),
      mon.sp,
    ];
  });

  const str = JSON.stringify(canonical);

  // djb2 hash → hex string
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // keep as unsigned 32-bit
  }
  return h.toString(16).padStart(8, '0');
}
