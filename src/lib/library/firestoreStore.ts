'use client';

/**
 * Firestore-backed team library — the drop-in adapter store.ts was designed for.
 *
 * Layout: users/{uid}/teams/{teamId}. Each document is the SavedTeam as-is plus `ownerUid`, so
 * rules can enforce ownership on the field as well as the path. Timestamps stay as Unix ms
 * numbers (the app already sorts on them) rather than Firestore Timestamps, so the object that
 * comes back is exactly what went in.
 */
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, type Firestore } from 'firebase/firestore';
import type { SavedTeam } from './types';
import type { TeamStore } from './store';

export const TEAMS_PATH = (uid: string) => `users/${uid}/teams`;

/** Strip undefined fields — Firestore rejects them, and SavedTeam has optional ones. */
function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FirestoreTeamStore implements TeamStore {
  constructor(private readonly db: Firestore, private readonly uid: string) {}

  async list(): Promise<SavedTeam[]> {
    const snap = await getDocs(collection(this.db, TEAMS_PATH(this.uid)));
    return snap.docs.map((d) => d.data() as SavedTeam);
  }

  async get(id: string): Promise<SavedTeam | null> {
    const snap = await getDoc(doc(this.db, TEAMS_PATH(this.uid), id));
    return snap.exists() ? (snap.data() as SavedTeam) : null;
  }

  async save(team: SavedTeam): Promise<void> {
    await setDoc(doc(this.db, TEAMS_PATH(this.uid), team.id), clean({ ...team, ownerUid: this.uid }));
  }

  async remove(id: string): Promise<void> {
    await deleteDoc(doc(this.db, TEAMS_PATH(this.uid), id));
  }
}
