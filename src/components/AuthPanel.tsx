'use client';

/**
 * Sign-in control for the header plus the sign-in modal.
 *
 * Providers: Email/Password (sign in or create) and Google (popup). Both go through the
 * Firebase Auth web SDK; nothing here talks to a server of ours. When Firebase is not configured
 * the control renders nothing and the app stays in guest mode.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';
import { firebaseAuth } from '@/lib/firebase/client';
import { useAuth } from '@/components/AuthProvider';
import { useIsMobile } from '@/hooks/useIsMobile';

type Tab = 'email' | 'google';

const FRIENDLY: Record<string, string> = {
  'auth/invalid-email': 'That email address is not valid.',
  'auth/user-not-found': 'No account with that email. Switch to "Create account".',
  'auth/wrong-password': 'Wrong password.',
  'auth/invalid-credential': 'Email or password is wrong.',
  'auth/email-already-in-use': 'That email already has an account. Switch to "Sign in".',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/popup-closed-by-user': 'The Google window was closed before finishing.',
  'auth/unauthorized-domain': 'This domain is not authorized for sign-in in the Firebase project.',
  'auth/operation-not-allowed': 'This sign-in method is not enabled in the Firebase project yet.',
  'auth/too-many-requests': 'Too many attempts. Wait a bit and try again.',
};
function friendly(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  return FRIENDLY[code] ?? (e as Error)?.message ?? 'Something went wrong.';
}

/** Header button: "Sign in" when signed out; name + sign out when signed in. */
export default function AuthControl() {
  const { user, ready, enabled, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  if (!enabled) return null;
  if (!ready) return <span style={{ fontSize: 11, color: '#40406a' }}>…</span>;

  if (user) {
    const label = user.displayName || user.email || 'Signed in';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {user.photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.photoURL} alt="" referrerPolicy="no-referrer" style={{ width: 22, height: 22, borderRadius: '50%' }} />
        ) : (
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(99,102,241,0.25)', color: '#c4c4f8', fontSize: 11, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {label.slice(0, 1).toUpperCase()}
          </span>
        )}
        {!isMobile && (
          <>
            <span style={{ fontSize: 11, color: '#9090c0', fontWeight: 700, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
            <button onClick={() => signOut()} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              Sign out
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setOpen(true)} style={{ padding: '5px 14px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        Sign in
      </button>
      {open && <SignInModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function SignInModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Email
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      const auth = firebaseAuth();
      if (!auth) throw new Error('Firebase is not configured.');
      if (mode === 'create') await createUserWithEmailAndPassword(auth, email.trim(), password);
      else await signInWithEmailAndPassword(auth, email.trim(), password);
      onClose();
    });
  }

  function resetPassword() {
    run(async () => {
      const auth = firebaseAuth();
      if (!auth) throw new Error('Firebase is not configured.');
      if (!email.trim()) throw new Error('Enter your email first.');
      await sendPasswordResetEmail(auth, email.trim());
      setNotice('Password reset email sent.');
    });
  }

  function google() {
    run(async () => {
      const auth = firebaseAuth();
      if (!auth) throw new Error('Firebase is not configured.');
      await signInWithPopup(auth, new GoogleAuthProvider());
      onClose();
    });
  }

  const input: React.CSSProperties = { width: '100%', background: 'rgba(4,4,14,0.9)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 8, padding: '8px 11px', fontSize: 13, color: '#e4e4f8', outline: 'none', colorScheme: 'dark', fontWeight: 600 };
  const primary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 13, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, width: '100%' };
  const link: React.CSSProperties = { background: 'none', border: 'none', color: '#8b8bf0', fontSize: 11, cursor: 'pointer', fontWeight: 700, padding: 0 };

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 900, color: '#eaeaf8' }}>Sign in</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)', padding: 3 }}>
        {(['email', 'google'] as Tab[]).map((t) => (
          <button key={t} onClick={() => { setTab(t); setError(null); setNotice(null); }} style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: 'none', background: tab === t ? 'rgba(99,102,241,0.22)' : 'transparent', color: tab === t ? '#e4e4f8' : '#6060a0', fontSize: 12, fontWeight: 800, cursor: 'pointer', textTransform: 'capitalize' }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'email' && (
        <form onSubmit={submitEmail} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={input} required />
          <input type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={input} required minLength={6} />
          <button type="submit" disabled={busy} style={primary}>{busy ? '…' : mode === 'create' ? 'Create account' : 'Sign in'}</button>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button type="button" onClick={() => setMode(mode === 'create' ? 'signin' : 'create')} style={link}>
              {mode === 'create' ? 'Have an account? Sign in' : 'New here? Create account'}
            </button>
            {mode === 'signin' && <button type="button" onClick={resetPassword} style={link}>Forgot password</button>}
          </div>
        </form>
      )}

      {tab === 'google' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={google} disabled={busy} style={{ ...primary, background: 'white', color: '#1f1f3a', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <GoogleMark /> {busy ? '…' : 'Continue with Google'}
          </button>
          <span style={{ fontSize: 11, color: '#50507a' }}>Opens a Google window; nothing else is shared with this site.</span>
        </div>
      )}

      {notice && <p style={{ marginTop: 10, fontSize: 12, color: '#34d399' }}>{notice}</p>}
      {error && <p style={{ marginTop: 10, fontSize: 12, color: '#f87171' }}>{error}</p>}
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(4,4,14,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ borderRadius: 14, border: '1px solid rgba(99,102,241,0.28)', background: 'rgba(11,11,28,0.98)', padding: '20px 22px', width: 360, maxWidth: '92vw', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}>
        {children}
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.2 0 11.6-2 15.6-5.6l-7.7-6c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
