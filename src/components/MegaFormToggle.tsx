'use client';

/**
 * Two cards, one per forme, for a Pokémon that holds its Mega Stone (or is stored as the Mega
 * forme): name, typing, abilities, base stats, and the computed stats for the current spread. The
 * active forme is highlighted; clicking the other switches the slot to that forme so every screen
 * (calc, speed tiers, benchmarks) evaluates the one the player wants to look at.
 */
import { STAT_ORDER, STAT_LABEL, calcChampionsStats, type SpSpread } from '@/lib/calc/sp';
import type { FormLists } from '@/lib/data/champions';
import type { MegaForms } from '@/lib/megaForms';
import { TypePill, MegaBadge } from '@/components/ui';

export default function MegaFormToggle({ forms, current, lists, sp, nature, onSwitch, compact = false }: {
  forms: MegaForms;
  current: string;
  lists: FormLists;
  sp: SpSpread;
  nature: string;
  onSwitch: (species: string) => void;
  compact?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
        Forme
        <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: '#35355a' }}>· holds {forms.stone} · Mega Evolves on its first attack</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[forms.base, forms.mega].map((species) => {
          const active = species === current;
          const base = lists.speciesStats[species];
          const computed = base ? calcChampionsStats(base, sp, nature) : null;
          const isMega = species === forms.mega;
          return (
            <button
              key={species}
              type="button"
              onClick={() => { if (!active) onSwitch(species); }}
              aria-pressed={active}
              title={active ? `Showing ${species}` : `Switch to ${species}`}
              style={{
                textAlign: 'left',
                cursor: active ? 'default' : 'pointer',
                borderRadius: 10,
                padding: compact ? '6px 8px' : '8px 10px',
                border: `1.5px solid ${active ? (isMega ? '#a78bfa' : '#6366f1') : 'rgba(99,102,241,0.16)'}`,
                background: active ? (isMega ? 'rgba(167,139,250,0.12)' : 'rgba(99,102,241,0.12)') : 'rgba(4,4,14,0.6)',
                color: active ? '#e4e4f8' : '#7070a8',
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: compact ? 11 : 12, fontWeight: 900, whiteSpace: 'nowrap' }}>{species}</span>
                {isMega ? <MegaBadge small /> : <span style={{ fontSize: 9, fontWeight: 800, color: '#50508a', textTransform: 'uppercase', letterSpacing: 0.6 }}>before</span>}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4 }}>
                {(lists.speciesTypes[species] ?? []).map((t) => <TypePill key={t} type={t} small />)}
              </div>
              <div style={{ fontSize: 10, color: active ? '#a0a0d0' : '#50507a', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={(lists.speciesAbilities[species] ?? []).join(' / ')}>
                {(lists.speciesAbilities[species] ?? []).join(' / ') || '—'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 2, fontFamily: "'Courier New', monospace", fontSize: 10 }}>
                {STAT_ORDER.map((s) => (
                  <div key={s} style={{ textAlign: 'center', minWidth: 0 }} title={`${STAT_LABEL[s]}: base ${base?.[s] ?? '?'}${computed ? ` → ${computed[s]} at Lv 50 with this spread` : ''}`}>
                    <div style={{ fontSize: 8, fontWeight: 800, color: '#40406a', letterSpacing: 0.5 }}>{STAT_LABEL[s].toUpperCase()}</div>
                    <div style={{ fontWeight: 700, color: active ? '#d0d0f0' : '#7070a8' }}>{base?.[s] ?? '?'}</div>
                    {computed && <div style={{ fontSize: 9, color: active ? '#8b8bf0' : '#50508a' }}>{computed[s]}</div>}
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
