'use client';

/**
 * One button for a Pokémon that holds its Mega Stone: it is both formes at once, and this flips
 * which one the slot shows (sprite, typing, ability, computed stats, every screen). The stone
 * itself puts the slot into the Mega forme; this only changes the view.
 */
import type { MegaForms } from '@/lib/megaForms';

export default function MegaFormToggle({ forms, current, onSwitch, small = false }: {
  forms: MegaForms;
  current: string;
  onSwitch: (species: string) => void;
  small?: boolean;
}) {
  const showingMega = current === forms.mega;
  const target = showingMega ? forms.base : forms.mega;
  return (
    <button
      type="button"
      onClick={() => onSwitch(target)}
      title={`Holds ${forms.stone}. Showing ${current}; click to show ${target}.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: small ? '3px 8px' : '4px 10px',
        borderRadius: 999,
        fontSize: small ? 10 : 11,
        fontWeight: 800,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        border: `1px solid ${showingMega ? 'rgba(167,139,250,0.6)' : 'rgba(99,102,241,0.35)'}`,
        background: showingMega ? 'rgba(167,139,250,0.16)' : 'rgba(99,102,241,0.1)',
        color: showingMega ? '#d8ccff' : '#a0a0e0',
      }}
    >
      <span aria-hidden>⇄</span>
      {showingMega ? `Show ${forms.base}` : `Show ${forms.mega}`}
    </button>
  );
}
