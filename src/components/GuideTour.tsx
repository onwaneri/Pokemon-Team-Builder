'use client';

/**
 * The walkthrough: a click-through slideshow of annotated screenshots of the app.
 *
 * Opens by itself the first time this browser visits (a localStorage flag, set the moment the
 * tour is closed by any route, so it never nags twice), and again whenever the header's
 * Options menu dispatches the 'vgc:open-guide' window event. Cancellable at every step:
 * the close button, Skip, Escape, or clicking the backdrop. Keyboard: left and right arrows move
 * between slides.
 *
 * Each slide is a real screenshot in public/guide/<id>.jpg with numbered callout boxes drawn over
 * it and the matching numbered notes underneath. The boxes are measured from the live DOM by
 * scripts/guide-shots.mjs, which also writes guideShots.json; the copy here is hand-written and
 * keyed by slide id. Re-run the script whenever the UI changes.
 */
import { useEffect, useState } from 'react';
import shots from './guideShots.json';

const STORAGE_KEY = 'vgc-champions-guide-v1';
export const OPEN_GUIDE_EVENT = 'vgc:open-guide';

interface Box { label: string; x: number; y: number; w: number; h: number }
interface Shot { width: number; height: number; boxes: Box[] }
const SHOTS = shots as Record<string, Shot>;

interface Slide {
  id: string;
  title: string;
  text: string;
}

const SLIDES: Slide[] = [
  {
    id: 'library',
    title: 'Team Library',
    text: 'Every saved team lives here with an AI-written overview and a suggested name. Teams save in this browser until you sign in; signing in moves them into your account and keeps saving there.',
  },
  {
    id: 'overview',
    title: 'The editor',
    text: 'A team opens into three views that share one assistant panel. The regulation selector in the header switches the whole app between ranked seasons without touching the open team.',
  },
  {
    id: 'editor',
    title: 'Building a set',
    text: 'Pickers are sorted by usage and filtered by what the Pokemon can actually learn in Champions. Stat Points replace EVs: 0 to 32 per stat, 66 in total. Anything illegal for the active regulation is flagged in the issues bar as you edit, never silently changed.',
  },
  {
    id: 'megas',
    title: 'Megas',
    text: 'Bring as many Mega-capable Pokemon as you like; only one can Mega Evolve in a given battle, and bringing one without evolving it is normal. Give a Pokemon its Mega Stone and the slot becomes the Mega forme.',
  },
  {
    id: 'assistant',
    title: 'AI Assistant',
    text: 'Ask a question or say what to change in plain language: "give Garchomp a Life Orb and max Speed", "set the defender to Incineroar", "turn on Trick Room and run all moves". Direct edits apply immediately; suggestions arrive as cards you accept or reject. Every number comes from the damage engine or live usage data, and each team keeps its own conversation.',
  },
  {
    id: 'builder',
    title: 'AI Team Builder',
    text: 'Describe a team, or place a few Pokemon and let it fill the rest. It plans an archetype, drafts sets from usage, then refines them against the top threats with real damage calcs, in short rounds.',
  },
  {
    id: 'builder-result',
    title: 'AI Team Builder: the result',
    text: 'The finished slots land in the team with a summary of the plan. Nothing is locked: edit any set, or undo the whole build with one click.',
  },
  {
    id: 'calc',
    title: 'Damage Calc',
    text: 'Attacker on the left, defender on the right, from your team or any Pokemon. Weather, terrain, format and crit live in the field bar below. Speed ties and Multiscale are flagged, never guessed.',
  },
  {
    id: 'speed',
    title: 'Speed Tiers',
    text: 'Your team against the speeds that matter in the format. Toggle Tailwind or Trick Room, set stat stages, Choice Scarf, paralysis and priority, and see exactly who moves first.',
  },
  {
    id: 'export',
    title: 'Export and share',
    text: 'Export any team as a Showdown paste, copy it, or share it as a PokePaste link. Import works the same way in reverse, from a paste or from a linked Showdown account.',
  },
  {
    id: 'options',
    title: 'Options',
    text: 'The assistant works out of the box on a built-in allowance. To go further, connect your own OpenAI, Gemini, Anthropic or OpenRouter key: it is sealed in an encrypted cookie on this device and never stored on the server. This guide is here whenever you want it back.',
  },
];

function markSeen() {
  try { localStorage.setItem(STORAGE_KEY, 'seen'); } catch { /* storage blocked: the tour simply shows again next visit */ }
}

function hasSeen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'seen'; } catch { return false; }
}

const ACCENT = '#fbbf24';

export default function GuideTour() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  // First visit: open once the page has painted. Later: whenever the options menu asks.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (!hasSeen()) { setIndex(0); setOpen(true); } }, 600);
    const onOpen = () => { setIndex(0); setOpen(true); };
    window.addEventListener(OPEN_GUIDE_EVENT, onOpen);
    return () => { window.clearTimeout(timer); window.removeEventListener(OPEN_GUIDE_EVENT, onOpen); };
  }, []);

  function close() {
    markSeen();
    setOpen(false);
  }

  const last = index === SLIDES.length - 1;
  function next() { if (last) close(); else setIndex((i) => i + 1); }
  function back() { setIndex((i) => Math.max(0, i - 1)); }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // Preload the next screenshot so paging never shows a blank frame.
  useEffect(() => {
    if (!open || last) return;
    const img = new Image();
    img.src = `/guide/${SLIDES[index + 1].id}.jpg`;
  }, [open, index, last]);

  if (!open) return null;
  const slide = SLIDES[index];
  const shot = SHOTS[slide.id];
  const boxes = shot?.boxes ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Guide"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(4,4,14,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeUp 0.18s ease' }}
    >
      <div style={{ width: 940, maxWidth: '100%', maxHeight: '100%', borderRadius: 16, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(11,11,28,0.98)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: '1px solid rgba(99,102,241,0.14)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px', color: '#50508a', whiteSpace: 'nowrap' }}>
              Guide {index + 1} of {SLIDES.length}
            </span>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: '#eaeaf8', letterSpacing: '-0.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{slide.title}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {!last && (
              <button onClick={close} style={{ background: 'none', border: 'none', color: '#6a6a9a', cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: '3px 6px' }}>
                Skip
              </button>
            )}
            <button onClick={close} title="Close" aria-label="Close guide" style={{ background: 'rgba(99,102,241,0.09)', border: '1px solid rgba(99,102,241,0.2)', color: '#8080b8', cursor: 'pointer', width: 26, height: 26, borderRadius: 7, fontSize: 16, lineHeight: 1 }}>
              ×
            </button>
          </div>
        </div>

        {/* Slide body: screenshot with callouts, notes underneath */}
        <div key={slide.id} style={{ overflowY: 'auto', minHeight: 0, animation: 'fadeUp 0.16s ease' }}>
          <div style={{ padding: '14px 16px 0' }}>
            <div style={{ position: 'relative', width: '100%', aspectRatio: shot ? `${shot.width} / ${shot.height}` : '14 / 9', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(99,102,241,0.22)', background: '#07071a' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/guide/${slide.id}.jpg`} alt={slide.title} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
              {boxes.map((b, i) => (
                <div key={i} aria-hidden style={{ position: 'absolute', left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, boxSizing: 'border-box', border: `2px solid ${ACCENT}`, borderRadius: 6, boxShadow: '0 0 0 1px rgba(0,0,0,0.55)', pointerEvents: 'none' }}>
                  <span style={{ position: 'absolute', left: -1, top: -1, transform: 'translate(-40%, -40%)', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: ACCENT, color: '#1a1200', fontSize: 11, fontWeight: 900, lineHeight: '20px', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: '12px 16px 6px', display: 'grid', gridTemplateColumns: boxes.length ? 'minmax(0, 1.1fr) minmax(0, 1fr)' : '1fr', gap: 16 }}>
            {boxes.length > 0 && (
              <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {boxes.map((b, i) => (
                  <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.5, color: '#c8c8e8' }}>
                    <span style={{ flexShrink: 0, minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: ACCENT, color: '#1a1200', fontSize: 11, fontWeight: 900, lineHeight: '20px', textAlign: 'center' }}>{i + 1}</span>
                    <span>{b.label}</span>
                  </li>
                ))}
              </ol>
            )}
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: '#a8a8cc' }}>{slide.text}</p>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px 14px', gap: 12, flexShrink: 0, borderTop: '1px solid rgba(99,102,241,0.1)' }}>
          <div style={{ display: 'flex', gap: 5 }} aria-hidden>
            {SLIDES.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setIndex(i)}
                title={s.title}
                style={{ width: i === index ? 18 : 7, height: 7, borderRadius: 4, border: 'none', padding: 0, cursor: 'pointer', background: i === index ? '#6366f1' : 'rgba(99,102,241,0.3)', transition: 'width 0.15s' }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={back}
              disabled={index === 0}
              style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.25)', background: 'transparent', color: index === 0 ? '#40406a' : '#c0c0e8', fontSize: 12, fontWeight: 800, cursor: index === 0 ? 'default' : 'pointer' }}
            >
              Back
            </button>
            <button
              onClick={next}
              autoFocus
              style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: 'white', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
