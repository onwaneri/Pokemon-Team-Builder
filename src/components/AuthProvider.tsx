'use client';

/**
 * Auth state + the team store that goes with it.
 *
 * Signed out (or Firebase not configured): the localStorage store, exactly as before.
 * Signed in: a FirestoreTeamStore scoped to the user's uid. Workspace reads `store` from here
 * instead of importing the localStorage singleton, so switching accounts swaps the library
 * without any screen knowing where teams live.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { firebaseAuth, firestoreDb, firebaseConfigured } from '@/lib/firebase/client';
import { teamStore as localStore, type TeamStore } from '@/lib/library/store';
import { FirestoreTeamStore } from '@/lib/library/firestoreStore';

interface AuthContextValue {
  /** null while the first auth check is still pending or when signed out. */
  user: User | null;
  /** False until Firebase has reported the initial auth state. */
  ready: boolean;
  /** Whether sign-in is available at all (public config present). */
  enabled: boolean;
  store: TeamStore;
  /** Increments every time the active store changes; Workspace reloads its list on it. */
  storeVersion: number;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  ready: true,
  enabled: false,
  store: localStore,
  storeVersion: 0,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!firebaseConfigured);

  useEffect(() => {
    const auth = firebaseAuth();
    if (!auth) return;
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  const store = useMemo<TeamStore>(() => {
    const db = user ? firestoreDb() : null;
    return user && db ? new FirestoreTeamStore(db, user.uid) : localStore;
  }, [user]);

  const [storeVersion, setStoreVersion] = useState(0);
  useEffect(() => {
    // Deferred so the bump never runs as a synchronous setState inside the effect body.
    const t = setTimeout(() => setStoreVersion((v) => v + 1), 0);
    return () => clearTimeout(t);
  }, [store]);

  async function signOut() {
    const auth = firebaseAuth();
    if (auth) await fbSignOut(auth);
  }

  return (
    <AuthContext.Provider value={{ user, ready, enabled: firebaseConfigured, store, storeVersion, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
