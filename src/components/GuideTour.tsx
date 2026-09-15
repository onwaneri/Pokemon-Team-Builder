'use client';

/**
 * The walkthrough: a click-through slideshow of screenshots of the app, one paragraph each.
 *
 * Opens by itself the first time this browser visits (a localStorage flag, set the moment the
 * tour is closed by any route, so it never nags twice), and again whenever the header's
 * Options menu dispatches the 'vgc:open-guide' window event. Cancellable at every step:
 * the close button, Skip, Escape, or clicking the backdrop. Keyboard: left and right arrows move
 * between slides.
 *
 * Each slide is a real screenshot: public/guide/<id>.jpg from the desktop layout, or
 * public/guide/m/<id>.jpg from the phone layout below the phone breakpoint, where the dialog is a
 * full-screen sheet. scripts/guide-shots.mjs captures both sets and writes guideShots.json with
 * each image's size (so the frame reserves the right aspect ratio before the image loads); the
 * copy here is hand-written and keyed by slide id. Re-run the script whenever the UI changes.
 */
import { useEffect, useState } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import shots from './guideShots.json';

const STORAGE_KEY = 'vgc-champions-guide-v1';
export const OPEN_GUIDE_EVENT = 'vgc:open-guide';

interface Shot { width: number; height: number }
const SHOTS = shots as { desktop: Record<string, Shot>; phone: Record<string, Shot> };

interface Slide {
  id: string;
  title: string;
  text: string;
}

const SLIDES: Slide[] = [
  {
    id: 'library',
    title: 'Team Library',
    text: 'Every saved team lives here with an AI-written overview and a suggested name. New Team starts from scratch and Import Team takes a Showdown paste; each card opens, exports, duplicates or deletes its team. Teams save in this browser until you sign in; signing in moves them into your account and keeps saving there.',
  },
  {
    id: 'overview',
    title: 'The editor',
    text: 'A team opens into three views, Team, Damage Calc and Speed Tiers, that share one assistant. The six slots sit above the set editor. The regulation selector in the header switches the whole app between ranked seasons without touching the open team.',
  },
  {
    id: 'editor',
    title: 'Building a set',
    text: 'Species, ability, item, nature and moves each have a picker sorted by usage and filtered by what the Pokemon can actually learn in Champions, and the popular Pikalytics sets apply with one click. Stat Points replace EVs: 0 to 32 per stat, 66 in total, on sliders whose plus and minus toggles set the nature. Anything illegal for the active regulation is flagged in the issues bar as you edit, never silently changed.',
  },
  {
    id: 'megas',
    title: 'Megas',
    text: 'Bring as many Mega-capable Pokemon as you like; only one can Mega Evolve in a given battle, and bringing one without evolving it is normal. Give a Pokemon its Mega Stone and the slot becomes the Mega forme. The toggle next to the name flips the view between the base forme and the Mega, so you can build and calc either one.',
  },
  {
    id: 'assistant',
    title: 'AI Assistant',
    text: 'Ask a question, or say what to change in plain language: "give Garchomp a Life Orb and max Speed", "set the defender to Incineroar", "turn on Trick Room and run all moves". Direct edits apply immediately; suggestions arrive as cards you accept or reject. Every number comes from the damage engine or live usage data, and the reply names the tools it ran. Each team keeps its own conversation.',
  },
  {
    id: 'builder',
    title: 'AI Team Builder',
    text: 'On the Team tab, describe the team you want, or place a few Pokemon and describe what is missing. The builder plans an archetype, drafts sets from usage, then refines them against the top threats with real damage calcs, in short rounds. Every slot stays editable.',
  },
  {
    id: 'builder-result',
    title: 'AI Team Builder: the result',
    text: 'The finished slots land in the team with a summary of the plan, each one a full legal set. Nothing is locked: edit any set, or undo the whole build with one click.',
  },
  {
    id: 'calc',
    title: 'Damage Calc',
    text: 'Attacker on one side, defender on the other, loaded from your team or any Pokemon. Click a move to calc it: the range appears on the move, with all sixteen rolls, the KO chance and a description below. The matchups strip picks the threats that matter for the Pokemon you are building around, and one click loads them. Weather, terrain, format and crit live in the field bar. Speed ties and Multiscale are flagged, never guessed.',
  },
  {
    id: 'speed',
    title: 'Speed Tiers',
    text: 'Your team against the speeds that matter in the format, with benchmarks chosen from the ranked usage for the Pokemon you have. Toggle Tailwind on either side or Trick Room, set stat stages, Choice Scarf, paralysis and priority, add any opponent, and see exactly who moves first.',
  },
  {
    id: 'export',
    title: 'Export and share',
    text: 'Export any team as a Showdown paste. Stat Points are written on the EVs line so Showdown reads them directly. Copy it, or share it as a PokePaste link. Import works the same way in reverse, from a paste or from a linked Showdown account.',
  },
  {
    id: 'options',
    title: 'Options',
    text: 'The Options menu in the header holds the visitor-level settings: link a Showdown account for ratings, replays and one-click team import; choose AI access; sign in to keep teams on your account; and reopen this guide. The assistant works out of the box on a built-in allowance. To go further, connect your own OpenAI, Gemini, Anthropic or OpenRouter key: it is sealed in an encrypted cookie on this device and never stored on the server.',
  },
];

function markSeen() {
  try { localStorage.setItem(STORAGE_KEY, 'seen'); } catch { /* storage blocked: the tour simply shows again next visit */ }
}

function hasSeen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'seen'; } catch { return false; }
}

export default function GuideTour() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const isMobile = useIsMobile();

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

  const src = (id: string) => (isMobile ? `/guide/m/${id}.jpg` : `/guide/${id}.jpg`);

  // Preload the next screenshot so paging never shows a blank frame.
  useEffect(() => {
    if (!open || last) return;
    const img = new Image();
    img.src = src(SLIDES[index + 1].id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, last, isMobile]);

  if (!open) return null;
  const slide = SLIDES[index];
  const shot = (isMobile ? SHOTS.phone : SHOTS.desktop)[slide.id];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Guide"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(4,4,14,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 0 : 20, animation: 'fadeUp 0.18s ease' }}
    >
      <div style={{ width: isMobile ? '100%' : 940, maxWidth: '100%', height: isMobile ? '100%' : undefined, maxHeight: '100%', borderRadius: isMobile ? 0 : 16, border: isMobile ? 'none' : '1px solid rgba(99,102,241,0.3)', background: 'rgba(11,11,28,0.98)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingTop: isMobile ? 'env(safe-area-inset-top)' : 0, paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : 0 }}>
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

        {/* Slide body: the screenshot, then the description */}
        <div key={slide.id} style={{ overflowY: 'auto', minHeight: 0, flex: isMobile ? 1 : undefined, animation: 'fadeUp 0.16s ease' }}>
          {isMobile ? (
            // Phone: the tall screenshot sizes itself to the height budget and keeps its own width,
            // so there are no letterbox bars beside it.
            <div style={{ padding: '12px 12px 0', display: 'flex', justifyContent: 'center' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src(slide.id)} alt={slide.title} style={{ display: 'block', maxHeight: '56vh', maxWidth: '100%', width: 'auto', height: 'auto', borderRadius: 10, border: '1px solid rgba(99,102,241,0.22)', background: '#07071a' }} />
            </div>
          ) : (
            <div style={{ padding: '14px 16px 0' }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: shot ? `${shot.width} / ${shot.height}` : '14 / 9', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(99,102,241,0.22)', background: '#07071a' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src(slide.id)} alt={slide.title} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
              </div>
            </div>
          )}
          <p style={{ margin: 0, padding: isMobile ? '12px 14px 8px' : '14px 18px 8px', fontSize: isMobile ? 13.5 : 13, lineHeight: 1.65, color: '#b8b8dc' }}>{slide.text}</p>
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
