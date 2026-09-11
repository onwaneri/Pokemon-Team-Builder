'use client';

/**
 * Header + workspace. The regulation selector lives here; the lists for every ruleset are computed
 * server-side once (page.tsx) and the active one is handed to Workspace, so switching regulations
 * is instant and never touches the team that is open.
 */
import { useEffect, useState } from 'react';
import Workspace from '@/components/Workspace';
import { useRuleset } from '@/components/RulesetProvider';
import AuthControl from '@/components/AuthPanel';
import AiKeyControl from '@/components/AiKeyControl';
import type { FormLists } from '@/lib/data/champions';
import { RULESETS, RULESET_IDS, type RulesetId } from '@/lib/rulesets';

interface RulesetStatus {
  usageFormat: string;
  usageFallbackFrom: string | null;
}

export default function AppShell({ listsByRuleset }: { listsByRuleset: Record<RulesetId, FormLists> }) {
  const { ruleset, setRuleset } = useRuleset();
  const lists = listsByRuleset[ruleset];
  const rules = RULESETS[ruleset];
  const [status, setStatus] = useState<RulesetStatus | null>(null);

  // Where the usage numbers actually come from for this ruleset (a newer regulation may still be
  // served by its predecessor's Pikalytics data).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ruleset?id=${ruleset}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RulesetStatus | null) => { if (!cancelled) setStatus(d); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [ruleset]);

  const fallbackLabel = status?.usageFallbackFrom
    ? RULESET_IDS.map((id) => RULESETS[id]).find((r) => r.pikalyticsFormats[0] === status.usageFormat)?.short ?? status.usageFormat
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: '#0b0b1a' }}>
      <header
        className="z-20 flex shrink-0 items-center justify-between"
        style={{
          height: 52,
          padding: '0 20px',
          borderBottom: '1px solid rgba(99,102,241,0.18)',
          background: 'rgba(9,9,22,0.97)',
        }}
      >
        <div className="flex items-center" style={{ gap: 12 }}>
          <div className="flex items-center" style={{ gap: 9 }}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <circle cx="11" cy="11" r="10" stroke="#6366f1" strokeWidth="1.5" />
              <line x1="1" y1="11" x2="21" y2="11" stroke="#6366f1" strokeWidth="1.5" />
              <circle cx="11" cy="11" r="3.5" fill="#0b0b1a" stroke="#6366f1" strokeWidth="1.5" />
              <circle cx="11" cy="11" r="1.5" fill="#6366f1" />
            </svg>
            <span style={{ fontSize: 17, fontWeight: 900, letterSpacing: '-0.5px', color: '#eaeaf8' }}>
              VGC Champions Tool
            </span>
          </div>
          <div style={{ width: 1, height: 18, background: 'rgba(99,102,241,0.18)' }} />
          <span style={{ fontSize: 11, color: '#40406a', fontWeight: 600 }}>
            {lists.species.length} species · {lists.moves.length} moves · {lists.items.length} items
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 10 }}>
          {fallbackLabel && (
            <span
              title={`Pikalytics has not published ${rules.short} usage yet. Usage percentages, popular sets, and rankings shown are ${fallbackLabel} data; Pokémon new to ${rules.short} have no usage data.`}
              style={{ fontSize: 10, fontWeight: 800, color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)', background: 'rgba(180,130,20,0.1)', borderRadius: 6, padding: '3px 8px', letterSpacing: '0.3px', whiteSpace: 'nowrap' }}
            >
              usage: {fallbackLabel} data
            </span>
          )}
          <span style={{ fontSize: 10, color: '#40406a', fontWeight: 600, whiteSpace: 'nowrap' }} title="Ranked season window">{rules.dates}</span>
          <AiKeyControl />
          <AuthControl />
          <select
            value={ruleset}
            onChange={(e) => setRuleset(e.target.value as RulesetId)}
            aria-label="Regulation"
            style={{
              background: 'rgba(99,102,241,0.09)',
              border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: 8,
              padding: '5px 10px',
              fontSize: 12,
              color: '#c0c0e8',
              outline: 'none',
              cursor: 'pointer',
              fontWeight: 700,
              colorScheme: 'dark',
            } as React.CSSProperties}
          >
            {RULESET_IDS.map((id) => (
              <option key={id} value={id}>{RULESETS[id].label}</option>
            ))}
          </select>
        </div>
      </header>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Workspace lists={lists} />
      </div>
    </div>
  );
}
