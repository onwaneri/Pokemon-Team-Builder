'use client';

import { useState, useEffect } from 'react';
import type { TeamMon } from '@/lib/benchmarks/types';
import type { FormLists } from '@/lib/data/champions';
import { calcChampionsStat, natureLabel, SP_PER_STAT_MAX } from '@/lib/calc/sp';
import { useUsage } from '@/hooks/useUsage';
import Combobox from '@/components/Combobox';
import CompareStrip from '@/components/CompareStrip';
import { Sprite } from '@/components/ui';
import type { SpeedEntryState, SpeedScreenState, CompareOpponent } from '@/lib/ai/types';

// ─── Priority options ─────────────────────────────────────────────────────────

const PRIORITY_OPTIONS: { value: number; label: string }[] = [
  { value: 5,  label: '+5 · Helping Hand' },
  { value: 4,  label: '+4 · Protect' },
  { value: 3,  label: '+3 · Fake Out' },
  { value: 2,  label: '+2 · Extreme Speed' },
  { value: 1,  label: '+1 · Quick Attack' },
  { value: 0,  label: '0 · Normal' },
  { value: -3, label: '−3 · Focus Punch' },
  { value: -6, label: '−6 · Counter' },
  { value: -7, label: '−7 · Trick Room' },
];
const PRIORITY_COLORS: Record<number, string> = {
  5: '#f59e0b', 4: '#10b981', 3: '#6366f1', 2: '#a78bfa',
  1: '#60a5fa', 0: '#50508a', [-3]: '#f87171', [-6]: '#f87171', [-7]: '#e879f9',
};

// natures that affect Speed
const SPE_BOOST_NATURES = new Set(['timid', 'jolly', 'hasty', 'naive']);
const SPE_DROP_NATURES  = new Set(['brave', 'quiet', 'relaxed', 'sassy']);

// ─── Speed formula ────────────────────────────────────────────────────────────

function stageMult(stage: number): number {
  if (stage >= 0) return (2 + stage) / 2;
  return 2 / (2 - stage);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SpeedEntry = SpeedEntryState;
type Computed = SpeedEntry & { effectiveSpeed: number };

export const DEFAULT_SPEED_STATE: SpeedScreenState = {
  tailwindMine: false,
  tailwindOpp: false,
  trickRoom: false,
  showPriority: false,
  entries: [],
};

/** Entry for one of the user's team members (Speed comes from the team set's computed stats). */
export function mineEntry(mon: TeamMon): SpeedEntryState {
  return {
    id: `team-${mon.slot}`, species: mon.species, side: 'mine', teamSlot: mon.slot,
    speSP: 0, nature: 'Hardy', stage: 0, paralyzed: false, scarf: false, priority: 0,
  };
}

/** Entry for an opponent; speSP 0 lets the card auto-fill from the usage top spread. */
export function oppEntry(species: string, nature?: string, speSP?: number): SpeedEntryState {
  return {
    id: `opp-${species}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    species, side: 'opp',
    speSP: speSP ?? 0, nature: nature ?? 'Hardy',
    stage: 0, paralyzed: false, scarf: false, priority: 0,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Toggles and entries are owned by Workspace (SpeedScreenState) so the assistant can read and edit
 * them and they survive tab switches. `onChange` takes an updater so patches from async sources
 * (usage auto-fill, the assistant) never clobber each other.
 */
export default function SpeedTierView({ team, lists, state, onChange }: {
  team: TeamMon[] | null;
  lists: FormLists;
  state: SpeedScreenState;
  onChange: (updater: (prev: SpeedScreenState) => SpeedScreenState) => void;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [addSpecies,   setAddSpecies]   = useState('');
  const { tailwindMine, tailwindOpp, trickRoom, showPriority, entries } = state;

  const setToggle = (key: 'tailwindMine' | 'tailwindOpp' | 'trickRoom' | 'showPriority') =>
    onChange((prev) => ({ ...prev, [key]: !prev[key] }));
  const setEntries = (updater: (prev: SpeedEntry[]) => SpeedEntry[]) =>
    onChange((prev) => ({ ...prev, entries: updater(prev.entries) }));

  const filledTeam = (team ?? []).filter((m): m is TeamMon => m !== null);
  const teamBySlot = new Map(filledTeam.map((m) => [m.slot, m]));
  const addedSlots = new Set(entries.filter((e) => e.teamSlot != null).map((e) => e.teamSlot!));

  // ── Entry management ──────────────────────────────────────────────────────

  function toggleTeamMon(mon: TeamMon) {
    if (addedSlots.has(mon.slot)) {
      setEntries((prev) => prev.filter((e) => e.teamSlot !== mon.slot));
    } else {
      setEntries((prev) => [...prev, mineEntry(mon)]);
    }
  }

  function addOpponent() {
    if (!addSpecies || !lists.speciesStats[addSpecies]) return;
    setEntries((prev) => [...prev, oppEntry(addSpecies)]);
    setAddSpecies('');
  }

  function addSuggested(opps: CompareOpponent[]) {
    setEntries((prev) => {
      const present = new Set(prev.filter((e) => e.side === 'opp').map((e) => e.species));
      const fresh = opps.filter((o) => !present.has(o.species) && lists.speciesStats[o.species]);
      return [...prev, ...fresh.map((o) => oppEntry(o.species, o.nature || undefined, o.sp.spe))];
    });
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function patchEntry(id: string, patch: Partial<SpeedEntry>) {
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e));
  }

  // ── Speed computation ─────────────────────────────────────────────────────

  function baseSpeedOf(e: SpeedEntry): number {
    if (e.teamSlot != null) {
      const mon = teamBySlot.get(e.teamSlot);
      if (mon) return mon.computedStats.spe;
    }
    return calcChampionsStat('spe', lists.speciesStats[e.species]?.spe ?? 0, e.speSP, e.nature);
  }

  function computeSpeed(e: SpeedEntry): number {
    const tailwind = e.side === 'mine' ? tailwindMine : tailwindOpp;
    let s = baseSpeedOf(e);
    s = Math.floor(s * stageMult(e.stage));
    if (e.paralyzed) s = Math.floor(s * 0.5);
    if (e.scarf)     s = Math.floor(s * 1.5);
    if (tailwind)    s = s * 2;
    return Math.floor(s);
  }

  const computed: Computed[] = entries.map((e) => ({ ...e, effectiveSpeed: computeSpeed(e) }));

  const sorted = [...computed].sort((a, b) => {
    if (showPriority && a.priority !== b.priority) return b.priority - a.priority;
    return trickRoom ? a.effectiveSpeed - b.effectiveSpeed : b.effectiveSpeed - a.effectiveSpeed;
  });

  const groups: { bracket: number; items: Computed[] }[] = [];
  if (showPriority) {
    const map = new Map<number, Computed[]>();
    for (const e of sorted) {
      if (!map.has(e.priority)) map.set(e.priority, []);
      map.get(e.priority)!.push(e);
    }
    for (const [bracket, items] of [...map.entries()].sort((a, b) => b[0] - a[0])) {
      groups.push({ bracket, items });
    }
  }

  // Suggested opponents are chosen for the team members on screen (or the whole team if none yet).
  const focusMons = entries.filter((e) => e.teamSlot != null).map((e) => teamBySlot.get(e.teamSlot!)).filter((m): m is TeamMon => !!m);
  const focusTeam = focusMons.length ? focusMons : filledTeam;

  // ── Renders ───────────────────────────────────────────────────────────────

  const glbToggle = (label: string, active: boolean, onClick: () => void) => (
    <button onClick={onClick} style={{
      padding: '5px 12px', borderRadius: 8,
      border: `1px solid ${active ? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.18)'}`,
      background: active ? 'rgba(99,102,241,0.22)' : 'transparent',
      color: active ? '#c4c4f8' : '#50508a', fontSize: 12, fontWeight: 700,
      cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>{label}</button>
  );

  const renderCard = (entry: Computed) => {
    const priColor = PRIORITY_COLORS[entry.priority] ?? PRIORITY_COLORS[0];

    return entry.side === 'opp'
      ? <OppCard key={entry.id} entry={entry} natures={lists.natures} onPatch={(p) => patchEntry(entry.id, p)} onRemove={() => removeEntry(entry.id)} priColor={priColor} />
      : (
        <div key={entry.id} style={{
          borderRadius: 12, border: '1.5px solid rgba(99,102,241,0.3)',
          background: 'rgba(15,15,35,0.9)',
          padding: '10px 11px', display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 6, width: 126, flexShrink: 0, position: 'relative',
        }}>
          <div style={{ position: 'absolute', top: 7, left: 9, fontSize: 9, fontWeight: 800, color: '#6366f1', letterSpacing: '0.4px' }}>MINE</div>
          <button onClick={() => removeEntry(entry.id)} style={{ position: 'absolute', top: 4, right: 7, background: 'none', border: 'none', color: '#40406a', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          <Sprite species={entry.species} size={50} style={{ marginTop: 8 }} />
          <div style={{ fontSize: 10, fontWeight: 800, color: '#c0c0e4', textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.species}</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#e4e4f8', lineHeight: 1 }}>{entry.effectiveSpeed}</div>
          <CardControls entry={entry} priColor={priColor} onPatch={(p) => patchEntry(entry.id, p)} />
        </div>
      );
  };

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 0 }}>

      {/* ── Left collapsible sidebar ── */}
      <div style={{ flexShrink: 0, borderRadius: 12, border: '1px solid rgba(99,102,241,0.18)', background: 'rgba(12,12,28,0.85)', overflow: 'hidden', width: sidebarOpen ? 150 : 30, transition: 'width 0.2s ease', display: 'flex', flexDirection: 'column' }}>
        {sidebarOpen ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 9px 6px' }}>
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a' }}>My Team</span>
              <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: '#40406a', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>‹</button>
            </div>
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {filledTeam.length === 0
                ? <div style={{ fontSize: 10, color: '#35355a', padding: '4px 0' }}>No team loaded</div>
                : filledTeam.map((mon) => {
                  const added = addedSlots.has(mon.slot);
                  return (
                    <button key={mon.slot} onClick={() => toggleTeamMon(mon)} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', borderRadius: 8, border: `1px solid ${added ? 'rgba(99,102,241,0.45)' : 'rgba(99,102,241,0.14)'}`, background: added ? 'rgba(99,102,241,0.16)' : 'rgba(4,4,14,0.7)', padding: '5px 7px', cursor: 'pointer', transition: 'all 0.12s' }}>
                      <Sprite species={mon.species} size={28} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: added ? '#c4c4f8' : '#7070a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mon.species}</span>
                    </button>
                  );
                })}
              {filledTeam.length > 1 && (
                <button onClick={() => setEntries((prev) => [...prev.filter((e) => e.teamSlot == null), ...filledTeam.map(mineEntry)])}
                  style={{ marginTop: 2, padding: '4px 0', borderRadius: 7, border: '1px solid rgba(99,102,241,0.2)', background: 'transparent', color: '#6060a0', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>
                  Add all
                </button>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10 }}>
            <button onClick={() => setSidebarOpen(true)} style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.22)', color: '#6366f1', cursor: 'pointer', padding: '6px 4px', borderRadius: 7, fontSize: 11, fontWeight: 800, writingMode: 'vertical-rl', textOrientation: 'mixed', letterSpacing: '0.5px', width: 22 } as React.CSSProperties}>Team</button>
          </div>
        )}
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {glbToggle('Tailwind (Mine)', tailwindMine, () => setToggle('tailwindMine'))}
          {glbToggle('Tailwind (Opp)',  tailwindOpp,  () => setToggle('tailwindOpp'))}
          {glbToggle('Trick Room',      trickRoom,    () => setToggle('trickRoom'))}
          {glbToggle('Priority',        showPriority, () => setToggle('showPriority'))}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ width: 170 }}>
              <Combobox value={addSpecies} onChange={setAddSpecies} options={lists.species} placeholder="Add opponent…" />
            </div>
            <button onClick={addOpponent} disabled={!addSpecies || !lists.speciesStats[addSpecies]}
              style={{ padding: '6px 13px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: addSpecies ? 'pointer' : 'not-allowed', opacity: addSpecies ? 1 : 0.45 }}>
              Add
            </button>
          </div>
        </div>

        {/* Dynamic speed benchmarks for the team members on screen */}
        {focusTeam.length > 0 && (
          <CompareStrip
            mode="speed"
            focus={focusTeam.map((m) => ({ species: m.species, ability: m.ability, item: m.item, nature: m.nature, sp: m.sp, moves: m.moves }))}
            teamSpecies={filledTeam.map((m) => m.species)}
            title={<>Speed benchmarks for {focusTeam.map((m) => m.species).join(', ')}</>}
            accent="#f87171"
            count={8}
            chipMeta={(opp) => <>{opp.nature || 'Hardy'} · Spe SP {opp.sp.spe ?? 0}{opp.item === 'Choice Scarf' ? ' · Scarf' : ''}</>}
            onPick={(opp) => addSuggested([opp])}
            onPickAll={addSuggested}
            headerExtra={focusMons.length === 0 ? <span style={{ fontSize: 9, color: '#50508a', fontWeight: 700 }}>based on your whole team — click members on the left to narrow</span> : null}
          />
        )}

        {/* Cards */}
        {sorted.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#40406a', fontSize: 13, fontWeight: 600 }}>
            Click team members on the left, pick a suggested benchmark above, or add any opponent to compare speeds.
          </div>
        ) : showPriority ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groups.map(({ bracket, items }) => {
              const color = PRIORITY_COLORS[bracket] ?? PRIORITY_COLORS[0];
              return (
                <div key={bracket}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.8px', color, whiteSpace: 'nowrap' }}>
                      {PRIORITY_OPTIONS.find((o) => o.value === bracket)?.label ?? `Priority ${bracket > 0 ? '+' : ''}${bracket}`}
                    </span>
                    <span style={{ flex: 1, height: 1, background: `${color}28` }} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{items.map(renderCard)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {trickRoom && <div style={{ width: '100%', fontSize: 10, fontWeight: 800, color: '#e879f9', letterSpacing: '0.8px', marginBottom: -4 }}>TRICK ROOM — slowest moves first</div>}
            {sorted.map(renderCard)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Opponent card (has its own usage hook) ───────────────────────────────────

function OppCard({ entry, natures, onPatch, onRemove, priColor }: {
  entry: Computed;
  natures: string[];
  onPatch: (patch: Partial<SpeedEntry>) => void;
  onRemove: () => void;
  priColor: string;
}) {
  const { usage } = useUsage(entry.species);

  // Auto-fill Spe SP from topSpread once usage loads, only if user hasn't touched it yet
  useEffect(() => {
    if (entry.speSP === 0 && usage?.topSpread?.spe != null && usage.topSpread.spe > 0) {
      onPatch({ speSP: usage.topSpread.spe });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage]);

  const natLower = entry.nature.toLowerCase();
  const natColor = SPE_BOOST_NATURES.has(natLower) ? '#34d399' : SPE_DROP_NATURES.has(natLower) ? '#f87171' : '#7070a0';

  return (
    <div style={{
      borderRadius: 12, border: '1.5px solid rgba(248,113,113,0.25)',
      background: 'rgba(20,10,15,0.9)',
      padding: '10px 11px', display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 6, width: 148, flexShrink: 0, position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: 7, left: 9, fontSize: 9, fontWeight: 800, color: '#f87171', letterSpacing: '0.4px' }}>OPP</div>
      <button onClick={onRemove} style={{ position: 'absolute', top: 4, right: 7, background: 'none', border: 'none', color: '#40406a', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>

      <Sprite species={entry.species} size={50} style={{ marginTop: 8 }} />
      <div style={{ fontSize: 10, fontWeight: 800, color: '#c0c0e4', textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.species}</div>

      <div style={{ fontSize: 22, fontWeight: 900, color: '#e4e4f8', lineHeight: 1 }}>{entry.effectiveSpeed}</div>

      {/* Nature + Spe SP */}
      <div style={{ display: 'flex', gap: 4, width: '100%', alignItems: 'center' }}>
        <select value={entry.nature} onChange={(e) => onPatch({ nature: e.target.value })}
          style={{ flex: 1, minWidth: 0, fontSize: 10, background: 'rgba(4,4,14,0.9)', border: `1px solid ${natColor}55`, borderRadius: 5, color: natColor, padding: '3px 3px', fontWeight: 700, colorScheme: 'dark' } as React.CSSProperties}>
          {natures.map((n) => <option key={n} value={n}>{natureLabel(n)}</option>)}
        </select>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 8, fontWeight: 800, color: '#40406a', letterSpacing: '0.3px', marginBottom: 1 }}>SPE SP</span>
          <input type="number" min={0} max={SP_PER_STAT_MAX} value={entry.speSP}
            onChange={(e) => { const v = Math.max(0, Math.min(SP_PER_STAT_MAX, parseInt(e.target.value) || 0)); onPatch({ speSP: v }); }}
            style={{ width: 36, textAlign: 'center', background: 'rgba(4,4,14,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 5, color: '#c0c0e4', padding: '2px 2px', fontSize: 11, fontWeight: 800, colorScheme: 'dark', outline: 'none' } as React.CSSProperties}
          />
        </div>
      </div>

      <CardControls entry={entry} priColor={priColor} onPatch={onPatch} />
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Priority select, stage stepper, and PAR/SCARF toggles — identical on both card kinds. */
function CardControls({ entry, priColor, onPatch }: { entry: SpeedEntry; priColor: string; onPatch: (patch: Partial<SpeedEntry>) => void }) {
  return (
    <>
      <select value={entry.priority} onChange={(e) => onPatch({ priority: parseInt(e.target.value) })}
        style={{ fontSize: 10, background: 'rgba(4,4,14,0.9)', border: `1px solid ${priColor}44`, borderRadius: 5, color: priColor, padding: '2px 3px', width: '100%', fontWeight: 700, colorScheme: 'dark' } as React.CSSProperties}>
        {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <StageBtn onClick={() => onPatch({ stage: Math.max(-6, entry.stage - 1) })}>−</StageBtn>
        <span style={{ fontSize: 11, fontWeight: 800, color: entry.stage !== 0 ? '#a78bfa' : '#50508a', minWidth: 22, textAlign: 'center' }}>{entry.stage > 0 ? `+${entry.stage}` : entry.stage}</span>
        <StageBtn onClick={() => onPatch({ stage: Math.min(6, entry.stage + 1) })}>+</StageBtn>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <CondBtn label="PAR" active={entry.paralyzed} color="#fbbf24" onClick={() => onPatch({ paralyzed: !entry.paralyzed })} />
        <CondBtn label="SCARF" active={entry.scarf} color="#60a5fa" onClick={() => onPatch({ scarf: !entry.scarf })} />
      </div>
    </>
  );
}

function StageBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ width: 22, height: 22, borderRadius: 6, border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.08)', color: '#7070b0', cursor: 'pointer', fontSize: 14, fontWeight: 700, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 }}>
      {children}
    </button>
  );
}

function CondBtn({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ padding: '2px 5px', borderRadius: 5, fontSize: 9, fontWeight: 800, cursor: 'pointer', border: `1px solid ${active ? color : 'rgba(99,102,241,0.2)'}`, background: active ? `${color}22` : 'transparent', color: active ? color : '#40406a', transition: 'all 0.12s' }}>
      {label}
    </button>
  );
}
