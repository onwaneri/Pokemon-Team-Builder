'use client';

/**
 * Dynamic comparison chips for the Damage Calc and Speed Tier screens.
 *
 * Asks /api/compare-set which opponents matter for the given focus Pokémon and renders them as
 * one-click chips. The list refreshes (debounced) whenever the focus changes, so switching your
 * attacker from Garchomp to Rotom-Wash swaps the threats to compare against. Chips are
 * suggestions only — the regular pickers still accept any species.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { CompareOpponent, CompareSetResponse } from '@/lib/ai/types';
import type { FocusMon, CompareMode } from '@/lib/ai/compareSet';
import { useRuleset } from '@/components/RulesetProvider';
import { aiFetch } from '@/lib/aiFetch';
import { Sprite } from '@/components/ui';

export default function CompareStrip({
  mode,
  focus,
  teamSpecies,
  title,
  onPick,
  onPickAll,
  chipMeta,
  headerExtra,
  accent = '#a78bfa',
  count,
}: {
  mode: CompareMode;
  focus: FocusMon[];
  teamSpecies: string[];
  title: ReactNode;
  onPick: (opp: CompareOpponent) => void;
  onPickAll?: (opps: CompareOpponent[]) => void;
  /** Extra line under the species name (e.g. nature + Speed SP). */
  chipMeta?: (opp: CompareOpponent) => ReactNode;
  headerExtra?: ReactNode;
  accent?: string;
  count?: number;
}) {
  const { ruleset } = useRuleset();
  const [data, setData] = useState<CompareSetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the parts of the focus that change the answer participate in the key, so typing SP
  // values or changing a nature does not refetch.
  const key = JSON.stringify({
    ruleset,
    mode,
    count,
    focus: focus.map((f) => [f.species, f.item ?? '', (f.moves ?? []).filter(Boolean)]),
  });

  useEffect(() => {
    if (!focus.length) return;
    let cancelled = false;
    // Debounced: state updates happen inside the timer callback, never synchronously in the effect.
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await aiFetch('/api/compare-set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, focus, teamSpecies, count, regulation: ruleset }),
        });
        const json = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(json.error ?? 'Could not load comparisons.'); setData(null); }
        else setData(json as CompareSetResponse);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!focus.length) return null;
  const opponents = data?.opponents ?? [];

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${accent}33`, background: 'rgba(12,12,28,0.85)', padding: '9px 12px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '1px', color: accent }}>✦ {title}</span>
        {loading && <span style={{ fontSize: 10, color: '#50508a', fontStyle: 'italic' }}>{data ? 'refreshing…' : 'choosing threats…'}</span>}
        <div style={{ flex: 1 }} />
        {headerExtra}
        {onPickAll && opponents.length > 0 && (
          <button
            onClick={() => onPickAll(opponents)}
            style={{ padding: '3px 9px', borderRadius: 6, border: `1px solid ${accent}55`, background: 'transparent', color: accent, fontSize: 10, cursor: 'pointer', fontWeight: 800 }}
          >
            Add all
          </button>
        )}
      </div>
      {error ? (
        <div style={{ fontSize: 11, color: '#f87171' }}>{error}</div>
      ) : opponents.length === 0 && !loading ? (
        <div style={{ fontSize: 11, color: '#40406a' }}>No comparisons available.</div>
      ) : (
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {opponents.map((opp) => (
            <button
              key={opp.species}
              onClick={() => onPick(opp)}
              title={`${opp.reason}\n${opp.species} @ ${opp.item || '—'} · ${opp.ability || '—'} · ${opp.nature}\n${opp.moves.filter(Boolean).join(' / ')}`}
              style={{
                flexShrink: 0,
                width: 124,
                textAlign: 'left',
                borderRadius: 9,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(99,102,241,0.18)',
                background: 'rgba(4,4,14,0.75)',
                padding: '6px 8px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                transition: 'border-color 0.12s, background 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${accent}88`; e.currentTarget.style.background = `${accent}14`; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.18)'; e.currentTarget.style.background = 'rgba(4,4,14,0.75)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <Sprite species={opp.species} size={28} alt="" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 800, color: '#d0d0f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {opp.species}
                </span>
              </div>
              {chipMeta && <div style={{ fontSize: 9, color: '#7070a8', fontWeight: 700 }}>{chipMeta(opp)}</div>}
              <div style={{ fontSize: 9, color: '#6a6a9a', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                {opp.reason}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
