'use client';

/**
 * The header's ⚙ Options menu: everything that is about the visitor rather than the team.
 *   - Showdown account: link a username (ratings, replays, public teams with one-click import)
 *     and import from a Showdown link. Imports are handed to the workspace through the
 *     'vgc:import-paste' window event so this menu needs no reference into it.
 *   - AI access: opens the key panel (own key on any provider, or the built-in free tier).
 *   - Account: sign in / sign out, and where teams are being saved right now.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { SignInModal } from '@/components/AuthPanel';
import ShowdownPanel from '@/components/showdown/ShowdownPanel';

type Modal = 'showdown' | 'signin' | null;

const itemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  color: '#d0d0ec',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  borderRadius: 8,
};
const hintStyle: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: '#50507a', lineHeight: 1.4 };

export default function OptionsMenu() {
  const { user, enabled, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Options"
        style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.25)', background: open ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.09)', color: '#c0c0e8', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        ⚙ Options
      </button>

      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 300, borderRadius: 12, border: '1px solid rgba(99,102,241,0.28)', background: 'rgba(11,11,28,0.98)', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', padding: 6, zIndex: 100, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button role="menuitem" style={itemStyle} onClick={() => pick(() => setModal('showdown'))}>
            Showdown account
            <span style={hintStyle}>Link a username for ratings, replays, and one-click team import. Import from a Showdown link too.</span>
          </button>
          <button role="menuitem" style={itemStyle} onClick={() => pick(() => window.dispatchEvent(new CustomEvent('vgc:open-ai-panel')))}>
            AI access
            <span style={hintStyle}>Use the built-in AI, or connect your own OpenAI, Gemini, Anthropic, or OpenRouter key. Works signed in or not.</span>
          </button>
          <div style={{ height: 1, background: 'rgba(99,102,241,0.15)', margin: '4px 6px' }} />
          {enabled && user ? (
            <button role="menuitem" style={itemStyle} onClick={() => pick(() => { signOut(); })}>
              Sign out
              <span style={hintStyle}>{user.displayName || user.email}. Teams save to this account; browser-only teams are moved in when you sign in.</span>
            </button>
          ) : enabled ? (
            <button role="menuitem" style={itemStyle} onClick={() => pick(() => setModal('signin'))}>
              Sign in
              <span style={hintStyle}>Teams currently save in this browser only. Sign in or create an account to keep them on your account; anything saved here moves over automatically.</span>
            </button>
          ) : (
            <div style={{ ...itemStyle, cursor: 'default', color: '#7070a0' }}>
              Guest mode
              <span style={hintStyle}>Sign-in is not configured on this server; teams save in this browser.</span>
            </div>
          )}
        </div>
      )}

      {modal === 'signin' && <SignInModal onClose={() => setModal(null)} />}
      {modal === 'showdown' && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }} style={{ position: 'fixed', inset: 0, background: 'rgba(4,4,14,0.75)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 60, zIndex: 1000, overflowY: 'auto' }}>
          <div style={{ width: 640, maxWidth: '94vw', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
              <span style={{ fontSize: 15, fontWeight: 900, color: '#eaeaf8' }}>Showdown account</span>
              <button onClick={() => setModal(null)} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            <ShowdownPanel onImportPaste={(text) => { window.dispatchEvent(new CustomEvent('vgc:import-paste', { detail: { text } })); setModal(null); }} />
          </div>
        </div>
      )}
    </div>
  );
}
