'use client';

/**
 * ShowdownPanel — "Link your Showdown account" for the library page.
 *
 * Unlinked: one input for the Showdown username (never a password). Linked: Champions rating for
 * the active ruleset's format (other Champions formats collapsed), the 5 most recent replays in
 * that format, and the user's public Showdown teams with an Import button each. Also an
 * "Import from a Showdown link" input for psim.us/t/… and teams.pokemonshowdown.com/view/… links.
 *
 * Every Import resolves the export text through /api/showdown/team and hands it to `onImportPaste`,
 * which should feed the app's normal import flow.
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { RULESETS, RULESET_IDS } from '@/lib/rulesets';
import { useRuleset } from '@/components/RulesetProvider';
import { useShowdown } from '@/hooks/useShowdown';

interface ShowdownPanelProps {
  onImportPaste: (paste: string) => void;
}

interface Rating { format: string; elo: number; gxe: number; w: number; l: number }
interface Profile { name: string; userid: string; ratings: Rating[] }
interface Replay { id: string; format: string; formatId: string; players: string[]; uploadtime: number; url: string }
interface PublicTeam { teamid: number; title: string; format: string; date: string }

type Loadable<T> = { status: 'idle' | 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string };

// ─── Styles ───────────────────────────────────────────────────────────────────

const panel: CSSProperties = {
  borderRadius: 12,
  border: '1px solid rgba(99,102,241,0.2)',
  background: 'rgba(14,14,30,0.9)',
  padding: '12px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const input: CSSProperties = {
  flex: 1,
  minWidth: 160,
  background: 'rgba(5,5,15,0.9)',
  border: '1px solid rgba(99,102,241,0.3)',
  borderRadius: 7,
  padding: '5px 9px',
  color: '#eaeaf8',
  fontSize: 12,
  outline: 'none',
  colorScheme: 'dark',
};

const primaryBtn: CSSProperties = {
  padding: '5px 12px',
  borderRadius: 7,
  background: '#6366f1',
  color: 'white',
  border: 'none',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const secondaryBtn: CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid rgba(99,102,241,0.22)',
  background: 'rgba(99,102,241,0.07)',
  color: '#8080b0',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const sectionTitle: CSSProperties = { fontSize: 10, fontWeight: 800, color: '#50508a', letterSpacing: '0.6px', textTransform: 'uppercase' };
const muted: CSSProperties = { fontSize: 11, color: '#40406a' };
const errorText: CSSProperties = { fontSize: 11, color: '#f87171' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLabel(formatId: string): string {
  for (const id of RULESET_IDS) if (RULESETS[id].pikalyticsFormats[0] === formatId) return RULESETS[id].label;
  const m = formatId.match(/^gen9championsvgc(\d{4})reg([a-z]+)$/);
  if (m) return `VGC ${m[1]} Reg ${m[2].toUpperCase().split('').join('-')}`;
  return formatId;
}

function shortDate(input: number | string): string {
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Request failed (HTTP ${r.status}).`);
  return data;
}

function useLoadable<T>(url: string | null): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'idle' });
  useEffect(() => {
    if (!url) { queueMicrotask(() => setState({ status: 'idle' })); return; }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setState({ status: 'loading' });
      getJson<T>(url)
        .then((data) => { if (!cancelled) setState({ status: 'ready', data }); })
        .catch((e: Error) => { if (!cancelled) setState({ status: 'error', error: e.message }); });
    });
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ShowdownPanel({ onImportPaste }: ShowdownPanelProps) {
  const { ruleset } = useRuleset();
  const activeFormat = RULESETS[ruleset].pikalyticsFormats[0];
  const { user, setUser, clearUser, hydrated } = useShowdown();

  const [nameInput, setNameInput] = useState('');
  const [showOtherRatings, setShowOtherRatings] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [importing, setImporting] = useState<string | null>(null); // ref currently being fetched
  const [importError, setImportError] = useState<string | null>(null);

  const u = user ? encodeURIComponent(user) : null;
  const profile = useLoadable<Profile>(u ? `/api/showdown/profile?user=${u}` : null);
  const replays = useLoadable<{ replays: Replay[] }>(u ? `/api/showdown/replays?user=${u}&format=${encodeURIComponent(activeFormat)}&limit=5` : null);
  const teams = useLoadable<{ teams: PublicTeam[] }>(u ? `/api/showdown/teams?user=${u}` : null);

  async function importRef(ref: string, password?: string) {
    if (importing) return;
    setImporting(ref);
    setImportError(null);
    try {
      const qs = new URLSearchParams({ ref, regulation: ruleset });
      if (password) qs.set('password', password);
      const data = await getJson<{ paste: string }>(`/api/showdown/team?${qs}`);
      onImportPaste(data.paste);
      setLinkInput('');
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(null);
    }
  }

  function submitLink(e: FormEvent) {
    e.preventDefault();
    const ref = linkInput.trim();
    if (ref) importRef(ref);
  }

  function submitName(e: FormEvent) {
    e.preventDefault();
    if (nameInput.trim()) { setUser(nameInput); setNameInput(''); }
  }

  const linkImportForm = (
    <form onSubmit={submitLink} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        value={linkInput}
        onChange={(e) => setLinkInput(e.target.value)}
        placeholder="Import from a Showdown link — psim.us/t/…, teams.pokemonshowdown.com/view/…, or an id"
        style={input}
        spellCheck={false}
      />
      <button type="submit" disabled={!linkInput.trim() || importing !== null} style={{ ...primaryBtn, opacity: !linkInput.trim() || importing ? 0.6 : 1 }}>
        {importing === linkInput.trim() && importing ? 'Importing…' : 'Import'}
      </button>
    </form>
  );

  // ─── Unlinked ───────────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div style={panel}>
        <form onSubmit={submitName} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#9090c0', whiteSpace: 'nowrap' }}>Link your Showdown username</span>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={hydrated ? 'Showdown username (no password needed)' : 'Loading…'}
            style={input}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" disabled={!nameInput.trim()} style={{ ...primaryBtn, opacity: nameInput.trim() ? 1 : 0.6 }}>Link</button>
        </form>
        {linkImportForm}
        {importError && <div style={errorText}>{importError}</div>}
      </div>
    );
  }

  // ─── Linked ─────────────────────────────────────────────────────────────────
  const activeRating = profile.status === 'ready' ? profile.data.ratings.find((r) => r.format === activeFormat) : undefined;
  const otherRatings = profile.status === 'ready' ? profile.data.ratings.filter((r) => r.format !== activeFormat) : [];

  return (
    <div style={panel}>
      {/* Header: username + rating for the active format */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#eaeaf8' }}>
          {profile.status === 'ready' ? profile.data.name : user}
        </span>
        <span style={{ ...muted, fontWeight: 600 }}>Showdown</span>

        {profile.status === 'loading' && <span style={{ ...muted, fontStyle: 'italic' }}>Loading ratings…</span>}
        {profile.status === 'error' && <span style={errorText}>{profile.error}</span>}
        {profile.status === 'ready' && (
          activeRating ? (
            <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, color: '#50508a' }}>{RULESETS[ruleset].short}</span>
              <Stat label="Elo" value={String(activeRating.elo)} />
              <Stat label="GXE" value={`${activeRating.gxe.toFixed(1)}%`} />
              <Stat label="W-L" value={`${activeRating.w}-${activeRating.l}`} />
            </span>
          ) : (
            <span style={muted}>No {RULESETS[ruleset].short} ladder games yet</span>
          )
        )}

        <div style={{ flex: 1 }} />
        {otherRatings.length > 0 && (
          <button onClick={() => setShowOtherRatings((s) => !s)} style={secondaryBtn}>
            {showOtherRatings ? 'Hide' : `${otherRatings.length} other format${otherRatings.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button onClick={() => { clearUser(); setShowOtherRatings(false); }} style={{ ...secondaryBtn, color: '#60608a' }} title="Forget this username">
          Unlink
        </button>
      </div>

      {showOtherRatings && otherRatings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 2 }}>
          {otherRatings.map((r) => (
            <div key={r.format} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, color: '#50508a', minWidth: 130 }}>{formatLabel(r.format)}</span>
              <Stat label="Elo" value={String(r.elo)} />
              <Stat label="GXE" value={`${r.gxe.toFixed(1)}%`} />
              <Stat label="W-L" value={`${r.w}-${r.l}`} />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        {/* Replays */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={sectionTitle}>Recent {RULESETS[ruleset].short} replays</span>
          {replays.status === 'loading' && <span style={{ ...muted, fontStyle: 'italic' }}>Loading…</span>}
          {replays.status === 'error' && <span style={errorText}>{replays.error}</span>}
          {replays.status === 'ready' && replays.data.replays.length === 0 && <span style={muted}>No public replays in this format.</span>}
          {replays.status === 'ready' && replays.data.replays.map((r) => {
            const opponent = r.players.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '') !== user.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? r.players.join(' vs ');
            return (
              <a
                key={r.id}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                title={r.players.join(' vs ')}
                style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, color: '#a5b4fc', textDecoration: 'none' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>vs {opponent}</span>
                <span style={{ ...muted, marginLeft: 'auto', flexShrink: 0 }}>{shortDate(r.uploadtime)}</span>
              </a>
            );
          })}
        </div>

        {/* Public teams */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={sectionTitle}>Your public Showdown teams</span>
          {teams.status === 'loading' && <span style={{ ...muted, fontStyle: 'italic' }}>Loading…</span>}
          {teams.status === 'error' && <span style={errorText}>{teams.error}</span>}
          {teams.status === 'ready' && teams.data.teams.length === 0 && (
            <span style={muted}>No public Champions teams. In Showdown&apos;s Teambuilder, upload a team and set it to public to see it here.</span>
          )}
          {teams.status === 'ready' && teams.data.teams.map((t) => {
            const ref = String(t.teamid);
            return (
              <div key={t.teamid} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#c0c0e0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={t.title}>
                  {t.title}
                </span>
                <span style={{ ...muted, flexShrink: 0 }}>{formatLabel(t.format)}</span>
                <span style={{ ...muted, flexShrink: 0 }}>{shortDate(t.date)}</span>
                <button onClick={() => importRef(ref)} disabled={importing !== null} style={{ ...secondaryBtn, opacity: importing && importing !== ref ? 0.5 : 1 }}>
                  {importing === ref ? 'Importing…' : 'Import'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {linkImportForm}
      {importError && <div style={errorText}>{importError}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: '#50508a', letterSpacing: '0.4px' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#eaeaf8', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  );
}
