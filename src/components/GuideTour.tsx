'use client';

/**
 * The walkthrough: a click-through slideshow of what the app can do.
 *
 * Opens by itself the first time this browser visits (a localStorage flag, set the moment the
 * tour is closed by any route, so it never nags twice), and again whenever the header's
 * ⚙ Options menu dispatches the 'vgc:open-guide' window event. Cancellable at every step:
 * the × button, Skip, Escape, or clicking the backdrop. Keyboard: ← → move between slides.
 * Pure UI; the slides are static copy kept in sync with README.md's "What it does".
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'vgc-champions-guide-v1';
export const OPEN_GUIDE_EVENT = 'vgc:open-guide';

interface Slide {
  icon: string;
  title: string;
  body: string;
  tip?: string;
}

const SLIDES: Slide[] = [
  {
    icon: '⚒',
    title: 'Welcome to Forge',
    body: 'A team builder for Pokémon Champions VGC. Build a team, check every set for legality, run the damage and speed math, and get help from an assistant whose numbers come from the real engine and live usage data.',
    tip: 'The regulation selector in the header switches the whole app between ranked seasons (Reg M-B, Reg M-C). The open team is never touched by a switch.',
  },
  {
    icon: '📚',
    title: 'Team Library',
    body: 'Every saved team lives here with an AI-written overview and a suggested name. Start from scratch, paste a Showdown team, or pull one of your public Showdown teams in with one click after linking your username in ⚙ Options.',
    tip: 'Teams save in this browser until you sign in. Signing in moves them into your account automatically and keeps saving there.',
  },
  {
    icon: '🧩',
    title: 'Team editor',
    body: 'Six slots. Pickers for species, ability, item, and moves are sorted by usage and filtered by learnset, and the popular Pikalytics sets apply with one click. Stat Points replace EVs: 0–32 per stat, 66 total, on sliders with + / − toggles that set the nature.',
    tip: 'Anything illegal for the active regulation is flagged in the issues bar as you edit, never silently fixed.',
  },
  {
    icon: '💎',
    title: 'Megas',
    body: 'Bring as many Mega-capable Pokémon as you like. Only one can Mega Evolve in a given battle, and bringing one without evolving it is normal. Give a Pokémon its Mega Stone and the slot becomes the Mega forme.',
    tip: 'The ⇄ toggle next to the name flips the view between the base forme and the Mega so you can calc either one.',
  },
  {
    icon: '✦',
    title: 'AI Assistant',
    body: 'The panel on the right sees the screen you are on. Ask a question, or say what to change in plain language: "give Garchomp a Life Orb and max Speed", "set the defender to Incineroar", "turn on Trick Room and run all moves". Direct edits apply immediately; suggestions arrive as cards you accept or reject.',
    tip: 'Each team keeps its own conversation. "New chat" in the panel header starts it over.',
  },
  {
    icon: '🏗',
    title: 'AI Team Builder',
    body: 'On the Team tab, describe what you want ("sun team, I like Incineroar") or place a few Pokémon and let it fill the rest. It plans an archetype, drafts sets from usage, then refines them against the top threats with real damage calcs.',
    tip: 'The result replaces the open slots with an Undo banner, so nothing is lost.',
  },
  {
    icon: '⚔',
    title: 'Damage Calc',
    body: 'Attacker on the left, defender on the right, pulled from your team or any Pokémon. Click a move to calc it: all 16 rolls, KO chance, and a Smogon-style line. The matchups strip below picks the threats that matter for the Pokémon you are building around; click one to load it.',
    tip: 'Weather, terrain, format, and crit live in the field bar. Speed ties and Multiscale are flagged, never guessed.',
  },
  {
    icon: '⚡',
    title: 'Speed Tiers',
    body: 'Your team against the speeds that matter in the format, with Tailwind and Trick Room toggles, stat stages, Choice Scarf, paralysis, and priority. See exactly who moves first, and by how much.',
  },
  {
    icon: '📤',
    title: 'Export and share',
    body: 'Export any team as a Showdown paste (Stat Points written as EVs so Showdown reads them), copy it, or share it as a PokePaste link. Import works the same way in reverse.',
  },
  {
    icon: '🔑',
    title: 'AI access and your account',
    body: 'The assistant works out of the box on a built-in allowance. To go further, connect your own OpenAI, Gemini, Anthropic, or OpenRouter key: it is sealed in an encrypted cookie on this device and never stored on the server. Sign in to keep your teams on your account across devices.',
    tip: 'Reopen this guide any time from ⚙ Options → Guide.',
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

  if (!open) return null;
  const slide = SLIDES[index];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Guide"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(4,4,14,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeUp 0.18s ease' }}
    >
      <div style={{ width: 560, maxWidth: '100%', borderRadius: 16, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(11,11,28,0.98)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(99,102,241,0.14)' }}>
          <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px', color: '#50508a' }}>
            Guide · {index + 1} / {SLIDES.length}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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

        {/* Slide */}
        <div key={index} style={{ padding: '26px 28px 18px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 250, animation: 'fadeUp 0.16s ease' }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: '#c7c7ff' }} aria-hidden>
            {slide.icon}
          </div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: '#eaeaf8', letterSpacing: '-0.3px' }}>{slide.title}</h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#b8b8dc' }}>{slide.body}</p>
          {slide.tip && (
            <p style={{ margin: 0, borderRadius: 9, border: '1px solid rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.08)', padding: '8px 11px', fontSize: 11.5, lineHeight: 1.55, color: '#a5a5f0' }}>
              {slide.tip}
            </p>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 16px', gap: 12 }}>
          <div style={{ display: 'flex', gap: 5 }} aria-hidden>
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setIndex(i)}
                title={SLIDES[i].title}
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
