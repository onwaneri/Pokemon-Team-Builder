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

/** Option-row extras shared by the move and item renderers. */
export interface OptionExtras {
  /** Pikalytics usage share for the current species, shown on the right. */
  pct?: number;
  /** Whether the row is the highlighted one (the Combobox passes this). */
  active?: boolean;
}

export function moveOptionNode(name: string, lists: FormLists, extras: OptionExtras = {}): ReactNode {
  const info = lists.moveInfo[name];
  const dim = extras.active ? 'rgba(255,255,255,0.72)' : '#6a6a9a';
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {info?.type ? <TypePill type={info.type} small /> : null}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {extras.pct ? <span style={{ fontSize: 10, fontWeight: 700, color: extras.active ? 'white' : '#8b8bf0', flexShrink: 0 }}>{Math.round(extras.pct * 10) / 10}%</span> : null}
        {info?.category && (
          <span style={{ fontSize: 9, color: dim, flexShrink: 0 }}>
            {info.category}{info.bp ? ` · ${info.bp}` : ''}
          </span>
        )}
      </span>
      {info?.desc && (
        <span style={{ fontSize: 10, color: dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>{info.desc}</span>
      )}
    </span>
  );
}

export function itemOptionNode(name: string, lists: FormLists, extras: OptionExtras = {}): ReactNode {
  const desc = lists.itemDesc[name];
  const dim = extras.active ? 'rgba(255,255,255,0.72)' : '#6a6a9a';
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {extras.pct ? <span style={{ fontSize: 10, fontWeight: 700, color: extras.active ? 'white' : '#8b8bf0', flexShrink: 0 }}>{Math.round(extras.pct * 10) / 10}%</span> : null}
      </span>
      {desc && (
        <span style={{ fontSize: 10, color: dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>{desc}</span>
      )}
    </span>
  );
}

/**
 * One muted line under a picker showing what the selected move / item / ability does. Truncates
 * with an ellipsis; the full text is in the tooltip. Renders nothing when there is no text.
 */
export function DescLine({ text, note, style }: { text?: string; note?: string; style?: CSSProperties }) {
  if (!text && !note) return null;
  return (
    <div
      title={[note, text].filter(Boolean).join(' · ')}
      style={{ fontSize: 10, color: '#50507a', fontWeight: 500, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 3, ...style }}
    >
      {note && <span style={{ color: '#d4a54a', fontWeight: 700 }}>{note}{text ? ' · ' : ''}</span>}
      {text}
    </div>
  );
}
