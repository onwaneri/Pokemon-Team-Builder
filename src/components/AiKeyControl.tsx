'use client';

/**
 * Header control for AI access: shows whether the visitor is on the built-in AI or their own key
 * (never a count — the free limit is a server-side secret), and opens a panel
 * where the visitor pastes their own key (OpenAI, Gemini, Anthropic, OpenRouter). The key goes to
 * /api/ai-key, is validated with the provider, and comes back only as an httpOnly cookie — this
 * component never sees it again. Opens automatically when a request is refused for quota, and on
 * the 'vgc:open-ai-panel' window event (the header options menu).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { emitAiEvent, type AiDeniedEvent, type AiUsageEvent } from '@/lib/aiFetch';

interface ProviderOption {
  id: string;
  label: string;
  /** Which model the server runs each tier on; shown so visitors know what their key is used for. */
  models: { fast: string; smart: string };
  keyPrefixHint: string;
  consoleUrl: string;
}
interface AiStatus {
  byok: { provider: string; fingerprint: string } | null;
  free: { configured: boolean; signedIn: boolean; exhausted: boolean };
  providers: ProviderOption[];
}

const btnBase: React.CSSProperties = {
  borderRadius: 8,
  padding: '5px 10px',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  // Longhands, not the `border` shorthand: variants override borderColor, and React warns when a
  // shorthand and its longhand change together between renders.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'rgba(99,102,241,0.25)',
  background: 'rgba(99,102,241,0.09)',
  color: '#c0c0e8',
};

export default function AiKeyControl() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/ai-key');
      if (r.ok) setStatus((await r.json()) as AiStatus);
    } catch {
      /* header stays quiet */
    }
  }, []);

  useEffect(() => {
    // Deferred so the initial status fetch never runs as a synchronous setState inside the effect.
    const t = setTimeout(() => { refresh(); }, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  // Live updates from aiFetch: denials open the panel; sign-in changes refresh the status.
  useEffect(() => {
    const onUsage = (e: Event) => {
      const d = (e as CustomEvent<AiUsageEvent>).detail;
      setStatus((s) => (s && d.source === 'free' && !s.free.signedIn ? { ...s, free: { ...s.free, signedIn: true } } : s));
    };
    const onDenied = (e: Event) => {
      const d = (e as CustomEvent<AiDeniedEvent>).detail;
      setNotice(d.message);
      setOpen(true);
      refresh();
    };
    const onChanged = () => refresh();
    const onOpen = () => { setNotice(null); setOpen(true); };
    window.addEventListener('vgc:ai-usage', onUsage);
    window.addEventListener('vgc:ai-denied', onDenied);
    window.addEventListener('vgc:ai-changed', onChanged);
    window.addEventListener('vgc:open-ai-panel', onOpen);
    return () => {
      window.removeEventListener('vgc:ai-usage', onUsage);
      window.removeEventListener('vgc:ai-denied', onDenied);
      window.removeEventListener('vgc:ai-changed', onChanged);
      window.removeEventListener('vgc:open-ai-panel', onOpen);
    };
  }, [refresh]);

  const label = !status
    ? 'AI'
    : status.byok
      ? `AI: ${status.providers.find((p) => p.id === status.byok!.provider)?.label ?? status.byok.provider} ${status.byok.fingerprint}`
      : !status.free.configured
        ? 'AI: connect a key'
        : status.free.exhausted
          ? 'AI: add your key'
          : 'AI: built-in';
  const warn = !!status && !status.byok && (!status.free.configured || status.free.exhausted);

  return (
    <>
      <button
        onClick={() => { setNotice(null); setOpen(true); }}
        title="AI access: your free requests, or connect your own API key"
        style={{ ...btnBase, ...(warn ? { borderColor: 'rgba(251,191,36,0.4)', color: '#fbbf24', background: 'rgba(180,130,20,0.1)' } : {}) }}
      >
        ✦ {label}
      </button>
      {open && status && (
        <AiKeyPanel
          status={status}
          notice={notice}
          onClose={() => setOpen(false)}
          onChanged={async () => { await refresh(); emitAiEvent('vgc:ai-changed', null); }}
        />
      )}
    </>
  );
}

function AiKeyPanel({ status, notice, onClose, onChanged }: { status: AiStatus; notice: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const [provider, setProvider] = useState(status.byok?.provider ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = status.providers.find((p) => p.id === provider);
  const connected = status.byok ? status.providers.find((p) => p.id === status.byok!.provider) : null;

  function pickProvider(id: string) {
    setProvider(id);
    setError(null);
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (busy || !apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/ai-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey }) });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Could not connect the key.'); return; }
      setApiKey('');
      await onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await fetch('/api/ai-key', { method: 'DELETE' });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle: React.CSSProperties = { width: '100%', background: 'rgba(4,4,14,0.9)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#e0e0f4', outline: 'none', fontWeight: 600, colorScheme: 'dark' };
  const labelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#50508a', marginBottom: 4 };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(4,4,14,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ borderRadius: 14, border: '1px solid rgba(99,102,241,0.28)', background: 'rgba(11,11,28,0.98)', padding: '20px 22px', width: 440, maxWidth: '92vw', boxShadow: '0 8px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 900, color: '#eaeaf8' }}>✦ AI access</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {notice && (
          <div style={{ borderRadius: 9, border: '1px solid rgba(251,191,36,0.3)', background: 'rgba(180,130,20,0.1)', padding: '8px 12px', fontSize: 12, color: '#fbbf24', lineHeight: 1.5 }}>{notice}</div>
        )}

        {/* Current state */}
        <div style={{ borderRadius: 10, border: '1px solid rgba(99,102,241,0.16)', background: 'rgba(12,12,28,0.85)', padding: '10px 12px', fontSize: 12, color: '#b0b0d8', lineHeight: 1.55 }}>
          {status.byok ? (
            <>
              Using <strong style={{ color: '#e4e4f8' }}>your {connected?.label ?? status.byok.provider} key</strong> ({status.byok.fingerprint}). No limits from this site; usage bills to your account.
              {connected && <ModelNote models={connected.models} />}
              <div style={{ marginTop: 8 }}>
                <button onClick={disconnect} disabled={busy} style={{ ...btnBase, borderColor: 'rgba(248,113,113,0.3)', color: '#fca5a5', background: 'transparent' }}>Disconnect key</button>
              </div>
            </>
          ) : !status.free.configured ? (
            <>The built-in AI is not configured on this server. Connect your own key to use AI features.</>
          ) : status.free.exhausted ? (
            <>That&apos;s all the built-in AI I can cover for you :) Add one of your own keys below to keep chatting, building, and optimizing.</>
          ) : (
            <>
              You&apos;re on the site&apos;s built-in AI, no sign-in needed. <strong style={{ color: '#e4e4f8' }}>Please don&apos;t drain my account :)</strong>{' '}Chat, team builds, SP optimizations, and benchmark parsing all run on it; when it runs out you&apos;ll be asked to add one of your own keys. Connect a key below any time, signed in or not, for unlimited use.
            </>
          )}
        </div>

        {/* Connect form */}
        <form onSubmit={connect} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={labelStyle}>{status.byok ? 'Switch to a different key' : 'Connect your own key'}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {status.providers.map((p) => (
                <button type="button" key={p.id} onClick={() => pickProvider(p.id)} style={{ ...btnBase, padding: '4px 10px', ...(provider === p.id ? { borderColor: '#6366f1', background: 'rgba(99,102,241,0.2)', color: '#e4e4f8' } : { color: '#7070a8' }) }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={labelStyle}>API key {info && <a href={info.consoleUrl} target="_blank" rel="noreferrer" style={{ color: '#6366f1', textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>get one ↗</a>}</div>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={info?.keyPrefixHint ?? 'API key'} style={fieldStyle as React.CSSProperties} />
          </div>
          {info && !status.byok && <ModelNote models={info.models} />}
          {error && <div style={{ fontSize: 11, color: '#f87171', lineHeight: 1.5 }}>{error}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="submit" disabled={busy || !apiKey.trim()} style={{ padding: '7px 18px', borderRadius: 9, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: busy || !apiKey.trim() ? 'not-allowed' : 'pointer', opacity: busy || !apiKey.trim() ? 0.6 : 1 }}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
            <span style={{ fontSize: 10, color: '#50507a', lineHeight: 1.4 }}>
              Validated with the provider, then stored encrypted in an httpOnly cookie on this device only. Never written to the server, never readable by page scripts.
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}

/** What the app will run on this provider; the visitor never picks a model, the job does. */
function ModelNote({ models }: { models: { fast: string; smart: string } }) {
  const same = models.fast === models.smart;
  return (
    <div style={{ marginTop: 6, fontSize: 10, color: '#50507a', lineHeight: 1.5 }}>
      Models are chosen per task:{' '}
      <code style={{ color: '#8b8bf0', fontSize: 10 }}>{models.smart}</code> for chat, team builds and SP optimization
      {same ? '' : <>, <code style={{ color: '#8b8bf0', fontSize: 10 }}>{models.fast}</code> for quick lookups</>}.
    </div>
  );
}
