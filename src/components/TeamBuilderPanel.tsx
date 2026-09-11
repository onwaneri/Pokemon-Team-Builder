'use client';

/**
 * Agentic team builder shown on the Team tab while slots are still open.
 *
 * Two entry points, one control: with an empty team it builds from a vague description; with a
 * few Pokémon already placed it finishes the team around them (those slots stay locked). The
 * result is applied straight to the team — Workspace keeps the previous slots for a one-click
 * undo — so building feels like an action, not a proposal.
 */
import { useState } from 'react';
import type { TeamMon } from '@/lib/benchmarks/types';
import { useRuleset } from '@/components/RulesetProvider';
import { aiFetch } from '@/lib/aiFetch';
import { Sprite } from '@/components/ui';

type TeamSlot = TeamMon | null;

const EXAMPLES_EMPTY = [
  'Rain team with a Trick Room mode for the mirror',
  'Hyper offense around Dragonite-Mega Tailwind',
  'Balanced team with Fake Out support and two speed control options',
];
const EXAMPLES_PARTIAL = [
  'Keep it standard, cover Fairy and Ice',
  'I want a Trick Room mode as the backup plan',
  'Add redirection and a second special attacker',
];

export default function TeamBuilderPanel({
  team,
  onBuilt,
}: {
  team: TeamSlot[];
  onBuilt: (result: { team: TeamSlot[]; summary: string }) => void;
}) {
  const { ruleset } = useRuleset();
  const filled = team.filter((m): m is TeamMon => m !== null);
  const open = 6 - filled.length;
  const [expanded, setExpanded] = useState(filled.length === 0);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (open === 0) return null;

  async function build() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await aiFetch('/api/build-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, team, regulation: ruleset }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Team build failed.'); return; }
      onBuilt({ team: data.team as TeamSlot[], summary: data.summary ?? '' });
      setPrompt('');
      setExpanded(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const examples = filled.length === 0 ? EXAMPLES_EMPTY : EXAMPLES_PARTIAL;
  const cta = filled.length === 0 ? 'Build team' : `Finish the other ${open}`;
  const heading = filled.length === 0 ? 'Build a team with AI' : `Finish this team with AI`;

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
          borderRadius: 12, border: '1px dashed rgba(167,139,250,0.35)', background: 'rgba(124,58,237,0.06)',
          padding: '9px 14px', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 13, color: '#a78bfa', fontWeight: 900 }}>✦</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: '#c4b5fd' }}>{heading}</span>
        <span style={{ fontSize: 11, color: '#6a6a9a' }}>
          {open} open slot{open > 1 ? 's' : ''} · describe what you want, or just let it fill the gaps around {filled.map((m) => m.species).join(', ')}
        </span>
      </button>
    );
  }

  return (
    <div style={{ borderRadius: 14, border: '1.5px solid rgba(167,139,250,0.35)', background: 'linear-gradient(180deg, rgba(124,58,237,0.09), rgba(12,12,28,0.85))', padding: 16, animation: 'fadeUp 0.18s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 15, color: '#a78bfa', fontWeight: 900 }}>✦</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: '#ede9fe', letterSpacing: '-0.2px' }}>{heading}</div>
          <div style={{ fontSize: 11, color: '#8a8ab8', marginTop: 2 }}>
            {filled.length === 0
              ? 'Say roughly what you want — an archetype, a Pokémon you like, a mode you need. Vague is fine.'
              : `Keeps ${filled.map((m) => m.species).join(', ')} exactly as they are and fills the remaining ${open} slot${open > 1 ? 's' : ''} around them.`}
          </div>
        </div>
        {filled.length > 0 && (
          <button onClick={() => setExpanded(false)} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }} title="Collapse">×</button>
        )}
      </div>

      {filled.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center' }}>
          {team.map((m, i) => m ? (
            <Sprite key={i} species={m.species} size={34} title={`Slot ${i + 1}: ${m.species} (locked)`} />
          ) : (
            <div key={i} title={`Slot ${i + 1}: open`} style={{ width: 34, height: 34, borderRadius: 7, border: '1px dashed rgba(167,139,250,0.4)', background: 'rgba(124,58,237,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a78bfa', fontSize: 14, fontWeight: 900 }}>?</div>
          ))}
        </div>
      )}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build(); }}
        placeholder={filled.length === 0 ? 'e.g. "sun team that can also play a Trick Room mode, I like Incineroar"' : 'Optional — anything the rest of the team should do or avoid'}
        rows={3}
        disabled={loading}
        style={{ width: '100%', borderRadius: 9, border: '1px solid rgba(167,139,250,0.25)', background: 'rgba(4,4,14,0.85)', padding: '10px 12px', fontSize: 12, color: '#d0d0f0', outline: 'none', resize: 'vertical', display: 'block', colorScheme: 'dark', fontWeight: 600 } as React.CSSProperties}
      />
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
        {examples.map((ex) => (
          <button key={ex} onClick={() => setPrompt(ex)} disabled={loading} style={{ padding: '3px 9px', borderRadius: 999, border: '1px solid rgba(167,139,250,0.22)', background: 'transparent', color: '#8a8ab8', fontSize: 10, cursor: 'pointer', fontWeight: 700 }}>
            {ex}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button
          onClick={build}
          disabled={loading}
          style={{ padding: '7px 20px', borderRadius: 9, background: loading ? 'rgba(124,58,237,0.45)' : 'linear-gradient(135deg,#a855f7,#6366f1)', color: 'white', border: 'none', fontSize: 13, fontWeight: 900, cursor: loading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
        >
          {loading ? 'Building…' : cta}
        </button>
        {loading && (
          <span style={{ fontSize: 11, color: '#8a8ab8', fontStyle: 'italic' }}>
            Looking up usage data, checking speed tiers, validating every set — usually 20–40 seconds.
          </span>
        )}
        {!loading && <span style={{ fontSize: 10, color: '#50507a' }}>⌘⏎ to build · you can edit every slot afterwards</span>}
        {error && <span style={{ fontSize: 11, color: '#f87171' }}>{error}</span>}
      </div>
    </div>
  );
}
