'use client';

/**
 * fetch() for AI routes.
 *
 * Adds the Firebase ID token when the visitor is signed in (so the free-tier counter follows the
 * account instead of the device), and turns the server's usage headers / 402 denials into window
 * events the key panel listens for:
 *   - 'vgc:ai-usage'  { source, provider }   after every AI response
 *   - 'vgc:ai-denied' { code, message }       when a request was refused
 * Callers still get the raw Response and handle their own JSON.
 */
import { firebaseAuth } from '@/lib/firebase/client';

export interface AiUsageEvent {
  source: 'free' | 'byok';
  provider: string | null;
}
export interface AiDeniedEvent {
  code: 'no_key' | 'sign_in_required' | 'quota_exhausted' | 'free_tier_unavailable';
  message: string;
}

export function emitAiEvent(name: 'vgc:ai-usage', detail: AiUsageEvent): void;
export function emitAiEvent(name: 'vgc:ai-denied', detail: AiDeniedEvent): void;
export function emitAiEvent(name: 'vgc:ai-changed', detail: null): void;
export function emitAiEvent(name: string, detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function idToken(): Promise<string | null> {
  try {
    const user = firebaseAuth()?.currentUser;
    return user ? await user.getIdToken() : null;
  } catch {
    return null;
  }
}

export async function aiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const token = await idToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });

  const source = res.headers.get('X-AI-Source');
  if (source === 'free' || source === 'byok') {
    emitAiEvent('vgc:ai-usage', { source, provider: res.headers.get('X-AI-Provider') });
  }
  if (res.status === 402) {
    const data = await res.clone().json().catch(() => ({}));
    emitAiEvent('vgc:ai-denied', { code: data.code ?? 'no_key', message: data.error ?? 'AI request refused.' });
  }
  return res;
}
