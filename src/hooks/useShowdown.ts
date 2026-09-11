'use client';

/**
 * The linked Pokémon Showdown username (display name only — never a password). Persisted per
 * browser; restored after mount so server and client render the same "not linked" default.
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'vgc-showdown-user-v1';

export function useShowdown() {
  const [user, setUserState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    // Deferred so the restore never runs as a synchronous setState inside the effect body.
    queueMicrotask(() => {
      if (stored?.trim()) setUserState(stored.trim());
      setHydrated(true);
    });
  }, []);

  function setUser(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setUserState(trimmed);
    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* best-effort */
    }
  }

  function clearUser() {
    setUserState(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* best-effort */
    }
  }

  return { user, setUser, clearUser, hydrated };
}
