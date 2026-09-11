'use client';

/**
 * Small presentational helpers shared by the editor screens: sprites, type pills, the Mega badge,
 * and the Combobox option renderers that use them. Pure display — no data fetching.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { FormLists } from '@/lib/data/champions';
import { spriteUrl } from '@/lib/data/sprite';
import { typeColor } from '@/lib/data/typeColors';

/**
 * Sprite that degrades to the species name when the image 404s (Champions-only formes).
 * `plain` drops the tinted box around the fallback text.
 */
export function MonSprite({ species, size, plain }: { species: string; size: number; plain?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [prevSpecies, setPrevSpecies] = useState(species);
  if (species !== prevSpecies) { setPrevSpecies(species); setFailed(false); }
  const url = spriteUrl(species);
  if (failed || !url) {
    return (
      <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(plain ? {} : { borderRadius: 8, background: 'rgba(99,102,241,0.08)' }) }}>
        <span style={{ fontSize: 8, color: '#50508a', textAlign: 'center', ...(plain ? {} : { padding: 2 }) }}>{species}</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={species} onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated' }} />;
}

/** Bare pixel-art sprite that keeps its box but turns invisible when the image 404s. */
export function Sprite({ species, size, alt, title, style }: { species: string; size: number; alt?: string; title?: string; style?: CSSProperties }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={spriteUrl(species)}
      alt={alt ?? species}
      title={title}
      style={{ width: size, height: size, imageRendering: 'pixelated', ...style }}
      onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0'; }}
    />
  );
}

export function TypePill({ type, small }: { type: string; small?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: small ? 4 : 6,
        background: typeColor(type),
        color: 'white',
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: small ? '0.2px' : '0.4px',
        fontSize: small ? 7 : 10,
        padding: small ? '1px 4px' : '2px 9px',
        flexShrink: 0,
      }}
    >
      {type}
    </span>
  );
}

/** Tiny type tag shown at the left of a move row. */
export function MoveTypeTag({ type }: { type: string }) {
  return (
    <span style={{ background: typeColor(type), color: 'white', fontSize: 7, fontWeight: 800, padding: '1px 4px', borderRadius: 3, textTransform: 'uppercase', flexShrink: 0 }}>
      {type}
    </span>
  );
}

export function MegaBadge({ small }: { small?: boolean }) {
  return (
    <span style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)', color: 'white', fontSize: small ? 8 : 9, fontWeight: 900, padding: small ? '2px 6px' : '2px 7px', borderRadius: small ? 4 : 5, letterSpacing: small ? undefined : '0.8px', textTransform: 'uppercase', flexShrink: 0 }}>
      MEGA
    </span>
  );
}

export function speciesOptionNode(name: string, lists: FormLists): ReactNode {
  return (
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {name}
        {lists.speciesIsMega[name] && <MegaBadge />}
      </span>
      <span style={{ display: 'flex', gap: 2 }}>
        {(lists.speciesTypes[name] ?? []).map((t) => <TypePill key={t} type={t} small />)}
      </span>
    </span>
  );
}

export function moveOptionNode(name: string, lists: FormLists): ReactNode {
  const info = lists.moveInfo[name];
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {info?.type ? <TypePill type={info.type} small /> : null}
      <span>{name}</span>
      {info?.category && <span style={{ marginLeft: 'auto', fontSize: 9, color: '#50508a' }}>{info.category}</span>}
    </span>
  );
}
