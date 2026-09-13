'use client';

/**
 * One row of compact "popular set" chips shared by the team slot editor and the damage calc
 * set editor. Each chip reads as `<role> · <item>[ · <nature>]`; the full set (player/record
 * label, ability, moves) sits in the tooltip, and clicking applies it.
 */
import type { PopularSet } from '@/lib/data/usage';
import type { FormLists } from '@/lib/data/champions';
import { describeSet } from '@/lib/data/setRole';

export default function PopularSets({ sets, lists, onApply, small }: {
  sets: PopularSet[];
  lists: FormLists;
  onApply: (s: PopularSet) => void;
  /** Slightly tighter chips for the narrow calc panels. */
  small?: boolean;
}) {
  if (!sets.length) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: small ? '0.8px' : 1, color: '#40406a', marginBottom: small ? 5 : 6 }}>
        Popular sets · Pikalytics
      </div>
      <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
        {sets.map((s, i) => {
          const role = describeSet(s, lists.moveInfo);
          const tail = [s.item || '—', s.nature].filter(Boolean).join(' · ');
          const tooltip = [
            s.label,
            `${s.ability || '—'} @ ${s.item || '—'}${s.nature ? ` · ${s.nature}` : ''}`,
            s.moves.filter(Boolean).join(' / '),
          ].filter(Boolean).join('\n');
          return (
            <button
              key={`${s.label}-${i}`}
              onClick={() => onApply(s)}
              title={tooltip}
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                borderRadius: 999,
                border: '1px solid rgba(99,102,241,0.2)',
                background: 'rgba(4,4,14,0.7)',
                padding: small ? '3px 9px' : '4px 11px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'border-color 0.12s, background 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.55)'; e.currentTarget.style.background = 'rgba(99,102,241,0.14)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'; e.currentTarget.style.background = 'rgba(4,4,14,0.7)'; }}
            >
              <span style={{ fontSize: small ? 10 : 11, fontWeight: 800, color: '#a5a5f0' }}>{role}</span>
              <span style={{ fontSize: small ? 9 : 10, fontWeight: 700, color: '#6a6a9a' }}>· {tail}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
