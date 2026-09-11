'use client';

/**
 * ShareButtons — "Share via PokePaste" for a Showdown export.
 *
 * POSTs the paste to /api/showdown/share, then shows the resulting URL with Copy and Open, plus a
 * one-line reminder of how to load it into Showdown's Teambuilder.
 */
import { useState, type CSSProperties } from 'react';

interface ShareButtonsProps {
  paste: string;
  title?: string;
}

const secondaryBtn: CSSProperties = {
  padding: '5px 12px',
  borderRadius: 7,
  border: '1px solid rgba(99,102,241,0.22)',
  background: 'rgba(99,102,241,0.07)',
  color: '#7070a0',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function ShareButtons({ paste, title }: ShareButtonsProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sharedFor, setSharedFor] = useState<string>('');

  // A new paste invalidates the previous link.
  if (url && sharedFor !== paste) { setUrl(null); setSharedFor(paste); }

  async function share() {
    if (sharing || !paste.trim()) return;
    setSharing(true);
    setError(null);
    try {
      const r = await fetch('/api/showdown/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paste, title: title ?? '' }),
      });
      const data = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !data.url) {
        setError(data.error ?? 'Could not create a PokePaste.');
      } else {
        setUrl(data.url);
        setSharedFor(paste);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  function copy() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => setError('Clipboard unavailable — copy the link manually.'));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={share}
          disabled={sharing || !paste.trim()}
          style={{
            padding: '5px 14px',
            borderRadius: 7,
            background: sharing ? 'rgba(99,102,241,0.5)' : '#6366f1',
            color: 'white',
            border: 'none',
            fontSize: 12,
            fontWeight: 800,
            cursor: sharing ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {sharing ? 'Creating PokePaste…' : url ? 'Share again' : 'Share via PokePaste'}
        </button>

        {url && (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 12,
                color: '#a5b4fc',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 260,
              }}
              title={url}
            >
              {url.replace(/^https?:\/\//, '')}
            </a>
            <button onClick={copy} style={secondaryBtn}>{copied ? 'Copied ✓' : 'Copy'}</button>
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...secondaryBtn, textDecoration: 'none' }}>
              Open
            </a>
          </>
        )}
      </div>

      {error && <div style={{ fontSize: 11, color: '#f87171' }}>{error}</div>}

      <div style={{ fontSize: 11, color: '#48487a', lineHeight: 1.5 }}>
        To use it on Showdown: Teambuilder → New Team → Import/Export, paste the export text (or the
        PokePaste contents), then Save.
      </div>
    </div>
  );
}
