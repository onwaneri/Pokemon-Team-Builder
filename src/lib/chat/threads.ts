/**
 * One assistant conversation per team, kept in this browser.
 *
 * Threads are keyed by saved-team id; the still-unsaved team in the editor uses the `DRAFT_THREAD`
 * key and is moved under the real id on first save. Storage is localStorage only (a per-device
 * convenience like the ruleset choice): nothing here syncs through Firestore, so a signed-in user
 * on another device starts each team's chat fresh. Each thread keeps its newest `MAX_MESSAGES`;
 * the store keeps its `MAX_THREADS` most recently used threads.
 *
 * `ChatMsg` carries `Set`s (dismissed proposals), which JSON drops, so threads are stored in a
 * plain shape and rebuilt on load. Every localStorage access is guarded: a blocked or full store
 * degrades to an in-memory-only conversation, never an error.
 */
import type { ChatMsg } from '@/hooks/useChampionsChat';

const STORAGE_KEY = 'vgc-champions-chats-v1';
export const DRAFT_THREAD = 'draft';
const MAX_MESSAGES = 60;
const MAX_THREADS = 40;

type StoredMsg = Omit<ChatMsg, 'dismissedProposals' | 'dismissedBenchmarks' | 'dismissedSubstitutions'> & {
  dismissedProposals?: number[];
  dismissedBenchmarks?: string[];
  dismissedSubstitutions?: string[];
};
interface StoredThread { messages: StoredMsg[]; updatedAt: number }
type Store = Record<string, StoredThread>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const keys = Object.keys(store).sort((a, b) => store[b].updatedAt - store[a].updatedAt).slice(0, MAX_THREADS);
    const trimmed: Store = {};
    for (const k of keys) trimmed[k] = store[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or storage blocked: the conversation still lives in React state.
  }
}

function freeze(m: ChatMsg): StoredMsg {
  return {
    ...m,
    dismissedProposals: m.dismissedProposals ? [...m.dismissedProposals] : undefined,
    dismissedBenchmarks: m.dismissedBenchmarks ? [...m.dismissedBenchmarks] : undefined,
    dismissedSubstitutions: m.dismissedSubstitutions ? [...m.dismissedSubstitutions] : undefined,
  };
}

function thaw(m: StoredMsg): ChatMsg {
  return {
    ...m,
    dismissedProposals: m.dismissedProposals ? new Set(m.dismissedProposals) : undefined,
    dismissedBenchmarks: m.dismissedBenchmarks ? new Set(m.dismissedBenchmarks) : undefined,
    dismissedSubstitutions: m.dismissedSubstitutions ? new Set(m.dismissedSubstitutions) : undefined,
  };
}

/** The stored conversation for a thread key; empty when there is none (or no storage). */
export function loadThread(key: string): ChatMsg[] {
  if (typeof window === 'undefined') return [];
  const t = readStore()[key];
  return Array.isArray(t?.messages) ? t.messages.map(thaw) : [];
}

/** Persist a thread (an empty conversation removes the entry). */
export function saveThread(key: string, messages: ChatMsg[]): void {
  if (typeof window === 'undefined') return;
  const store = readStore();
  if (messages.length === 0) delete store[key];
  else store[key] = { messages: messages.slice(-MAX_MESSAGES).map(freeze), updatedAt: Date.now() };
  writeStore(store);
}

/** Append to a stored thread without touching React state (a reply that landed after switching teams). */
export function appendToThread(key: string, message: ChatMsg): void {
  saveThread(key, [...loadThread(key), message]);
}

/** Re-key a thread (the draft becomes a saved team). A missing source is a no-op. */
export function moveThread(from: string, to: string): void {
  if (typeof window === 'undefined' || from === to) return;
  const store = readStore();
  const t = store[from];
  if (!t) return;
  delete store[from];
  store[to] = { ...t, updatedAt: Date.now() };
  writeStore(store);
}

export function deleteThread(key: string): void {
  if (typeof window === 'undefined') return;
  const store = readStore();
  if (!(key in store)) return;
  delete store[key];
  writeStore(store);
}
