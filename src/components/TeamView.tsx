'use client';

import { useRef, useState, type ReactNode } from 'react';
import type { Benchmark, BenchmarkStatus, TeamMon } from '@/lib/benchmarks/types';
import { calcChampionsStats, natureLabel, natureIssue, isCompleteNature, type SpSpread } from '@/lib/calc/sp';
import { padMoves } from '@/lib/moves';
import Combobox from '@/components/Combobox';
import SpEditor from '@/components/SpEditor';
import MegaFormToggle from '@/components/MegaFormToggle';
import { megaFormsFor, abilityForForme } from '@/lib/megaForms';
import type { FormLists } from '@/lib/data/champions';
import type { PopularSet } from '@/lib/data/usage';
import { useUsage, usageSortedItems } from '@/hooks/useUsage';
import { useLearnset, moveOptionsFor } from '@/hooks/useLearnset';
import { aiFetch } from '@/lib/aiFetch';
import PopularSets from '@/components/PopularSets';
import { MonSprite, TypePill, MoveTypeTag, MegaBadge, DescLine, speciesOptionNode, moveOptionNode, itemOptionNode } from '@/components/ui';

type TeamSlot = TeamMon | null;

const BENCH_COLOR: Record<BenchmarkStatus, string> = { passing: '#34d399', failing: '#f87171', needs_review: '#fbbf24' };
const BENCH_BORDER: Record<BenchmarkStatus, string> = { passing: 'rgba(52,211,153,0.3)', failing: 'rgba(248,113,113,0.3)', needs_review: 'rgba(251,191,36,0.3)' };
const BENCH_BG: Record<BenchmarkStatus, string> = { passing: 'rgba(16,185,129,0.07)', failing: 'rgba(239,68,68,0.07)', needs_review: 'rgba(245,158,11,0.07)' };
const BENCH_ICON: Record<BenchmarkStatus, string> = { passing: '✓', failing: '✗', needs_review: '?' };

export default function TeamView({ team, onUpdate, onAdd, onRemove, onReorder, onImportSlot, lists, reevaluating }: {
  team: TeamSlot[];
  onUpdate: (slot: number, mon: TeamMon) => void;
  onAdd: (slotIndex: number, species: string) => void;
  onRemove: (slotIndex: number) => void;
  onReorder: (from: number, to: number) => void;
  onImportSlot: (slotIndex: number, paste: string) => Promise<TeamMon | string>;
  lists: FormLists;
  reevaluating?: Set<number>;
}) {
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const active = team[activeSlotIndex] ?? null;
  // Set when a slot switch was refused because the active Pokémon's nature is half-picked; the
  // SP editor shows the warning in red until the nature is completed.
  const [natureNag, setNatureNag] = useState(false);
  const activeNatureIssue = active ? natureIssue(active.nature) : null;
  if (natureNag && !activeNatureIssue) setNatureNag(false);

  function selectSlot(i: number) {
    if (i !== activeSlotIndex && activeNatureIssue) { setNatureNag(true); return; }
    setActiveSlotIndex(i);
  }

  // Edits write straight through to the team; there is no per-slot draft to save or discard.
  async function handlePasteImport(paste: string): Promise<string | null> {
    const result = await onImportSlot(activeSlotIndex, paste);
    return typeof result === 'string' ? result : null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, animation: 'fadeUp 0.18s ease' }}>
      <SlotBar team={team} activeSlotIndex={activeSlotIndex} onSelect={selectSlot} onRemove={onRemove} onReorder={onReorder} lists={lists} reevaluating={reevaluating} />

      {active ? (
        <SlotWorkspace key={`${active.slot}:${active.species}`} mon={active} update={(m) => onUpdate(m.slot, m)} lists={lists} onPasteImport={handlePasteImport} natureNag={natureNag} />
      ) : (
        <EmptySlotPicker slotNumber={activeSlotIndex + 1} lists={lists} onPick={(species) => onAdd(activeSlotIndex, species)} onPasteImport={handlePasteImport} />
      )}
    </div>
  );
}

// ─── Slot bar ────────────────────────────────────────────────────────────────

function SlotBar({ team, activeSlotIndex, onSelect, onRemove, onReorder, lists, reevaluating }: {
  team: TeamSlot[];
  activeSlotIndex: number;
  onSelect: (i: number) => void;
  onRemove: (i: number) => void;
  onReorder: (from: number, to: number) => void;
  lists: FormLists;
  reevaluating?: Set<number>;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 3, flexShrink: 0 }}>
      {team.map((mon, i) => {
        const active = i === activeSlotIndex;
        return (
          <div
            key={i}
            draggable={!!mon}
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
            onDrop={() => { if (dragFrom !== null) { onReorder(dragFrom, i); setDragFrom(null); } }}
            onDragEnd={() => setDragFrom(null)}
            onClick={() => onSelect(i)}
            style={{
              flexShrink: 0,
              width: 110,
              borderRadius: 14,
              border: `2px solid ${active ? '#6366f1' : 'rgba(99,102,241,0.15)'}`,
              background: active ? 'rgba(99,102,241,0.1)' : 'rgba(14,14,30,0.8)',
              padding: '10px 8px 8px',
              cursor: 'pointer',
              transition: 'border-color 0.18s, box-shadow 0.18s, background 0.18s',
              boxShadow: active ? '0 0 20px rgba(99,102,241,0.25)' : 'none',
              position: 'relative',
            }}
          >
            {mon ? (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                  style={{ position: 'absolute', right: 6, top: 6, zIndex: 10, background: 'none', border: 'none', color: '#35355a', fontSize: 10, cursor: 'pointer', lineHeight: 1, padding: 0 }}
                  title="Remove"
                >
                  ✕
                </button>
                {reevaluating?.has(mon.slot) ? (
                  <div style={{ position: 'absolute', top: 7, left: 8, zIndex: 2 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(99,102,241,0.25)', borderTopColor: '#6366f1', animation: 'spin 0.8s linear infinite' }} />
                  </div>
                ) : mon.benchmarks.length > 0 && (
                  <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 3, zIndex: 2 }}>
                    {mon.benchmarks.slice(0, 4).map((b) => (
                      <span key={b.id} style={{ display: 'block', width: 6, height: 6, borderRadius: '50%', background: BENCH_COLOR[b.status], flexShrink: 0 }} />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 58, marginBottom: 5 }}>
                  <MonSprite species={mon.species} size={54} />
                </div>
                <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 800, color: '#e0e0f4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 4, padding: '0 2px' }}>
                  {mon.species}
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 3, marginBottom: 4, flexWrap: 'wrap' }}>
                  {(lists.speciesTypes[mon.species] ?? []).map((t) => (
                    <TypePill key={t} type={t} small />
                  ))}
                </div>
                <div style={{ textAlign: 'center', fontSize: 9, color: '#40406a', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 2px' }}>
                  {mon.item || 'No item'}
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', height: 88, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#35355a' }}>
                <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
                <span style={{ marginTop: 4, fontSize: 10 }}>Add</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Empty slot ───────────────────────────────────────────────────────────────

/** True when clipboard text looks like a Showdown set rather than a species name. */
function looksLikeSetPaste(text: string): boolean {
  return /\n/.test(text.trim()) || /^\s*(- |Ability:)/m.test(text);
}

function EmptySlotPicker({ slotNumber, lists, onPick, onPasteImport }: {
  slotNumber: number;
  lists: FormLists;
  onPick: (species: string) => void;
  onPasteImport: (paste: string) => Promise<string | null>;
}) {
  const [species, setSpecies] = useState('');
  const [pasteLoading, setPasteLoading] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // A multi-line paste into the species box is a whole set: send it to the importer instead of
  // filtering the species list with it.
  async function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text');
    if (!looksLikeSetPaste(text) || pasteLoading) return;
    e.preventDefault();
    setPasteLoading(true);
    setPasteError(null);
    const err = await onPasteImport(text);
    if (err) setPasteError(err);
    setPasteLoading(false);
  }

  return (
    <div style={{ borderRadius: 14, border: '1.5px dashed rgba(99,102,241,0.2)', background: 'rgba(12,12,28,0.5)', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#7070a0' }}>Add Pokémon to slot {slotNumber}</span>
        {pasteLoading && <span style={{ fontSize: 11, color: '#6366f1', fontStyle: 'italic' }}>Importing set…</span>}
      </div>
      <div onPaste={handlePaste}>
        <Combobox value={species} onChange={(s) => { setSpecies(s); onPick(s); }} options={lists.species} placeholder="Choose a species, or paste a Showdown set…" renderOption={(name) => speciesOptionNode(name, lists)} />
      </div>
      {pasteError ? (
        <p style={{ marginTop: 8, fontSize: 11, color: '#f87171' }}>{pasteError}</p>
      ) : (
        <p style={{ marginTop: 8, fontSize: 11, color: '#35355a' }}>Picking a species creates a legal default set you can then edit. Pasting a full set fills the slot with it.</p>
      )}
    </div>
  );
}

// ─── Slot workspace ───────────────────────────────────────────────────────────

function SlotWorkspace({ mon: draft, update, lists, onPasteImport, natureNag }: {
  mon: TeamMon;
  update: (m: TeamMon) => void;
  lists: FormLists;
  onPasteImport: (paste: string) => Promise<string | null>;
  natureNag?: boolean;
}) {
  const { usage, loadingUsage } = useUsage(draft.species);
  const { learnset } = useLearnset(draft.species);
  const [benchmarkInput, setBenchmarkInput] = useState('');
  const [benchmarkAdding, setBenchmarkAdding] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteLoading, setPasteLoading] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [optimizeLoading, setOptimizeLoading] = useState(false);
  const [optimizeReasoning, setOptimizeReasoning] = useState<string | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const benchmarkRef = useRef<HTMLInputElement>(null);
  const moveRefs = useRef<(HTMLInputElement | null)[]>([]);

  const baseStats = lists.speciesStats[draft.species];
  const abilityOptions = lists.speciesAbilities[draft.species]?.length ? lists.speciesAbilities[draft.species] : lists.abilities;
  const itemOptions = usageSortedItems(lists.items, usage?.items ?? []);
  const itemPct = new Map((usage?.items ?? []).map((e) => [e.name, e.pct]));
  const moveSections = moveOptionsFor(lists.moves, usage?.moves, learnset);
  const forms = megaFormsFor(draft.species, draft.item, lists);

  function recompute(sp: SpSpread, nature: string) {
    return baseStats ? calcChampionsStats(baseStats, sp, nature) : draft.computedStats;
  }
  function changeSpecies(species: string) {
    const abilities = lists.speciesAbilities[species] ?? [];
    const base = lists.speciesStats[species];
    const computedStats = base ? calcChampionsStats(base, draft.sp, draft.nature) : draft.computedStats;
    // Picking a Mega forme directly means holding its stone; nothing else is legal for it.
    update({ ...draft, species, ability: abilities[0] ?? '', item: lists.stoneOfMega[species] ?? '', computedStats });
  }
  /** Show the other forme: same spread, same stone, the forme's own typing/ability/base stats. */
  function switchForme(species: string) {
    if (!forms) return;
    const base = lists.speciesStats[species];
    const computedStats = base ? calcChampionsStats(base, draft.sp, draft.nature) : draft.computedStats;
    update({ ...draft, species, item: forms.stone, ability: abilityForForme(draft.ability, species, lists), computedStats });
  }
  function changeItem(item: string) {
    // A Mega forme without its stone cannot exist; taking the stone away shows the base forme.
    if (forms && draft.species === forms.mega && item !== forms.stone) {
      const base = lists.speciesStats[forms.base];
      const computedStats = base ? calcChampionsStats(base, draft.sp, draft.nature) : draft.computedStats;
      update({ ...draft, species: forms.base, item, ability: abilityForForme(draft.ability, forms.base, lists), computedStats });
      return;
    }
    update({ ...draft, item });
  }
  function changeNature(nature: string) {
    update({ ...draft, nature, computedStats: recompute(draft.sp, nature) });
  }
  function changeMove(index: number, value: string) {
    const moves = [...draft.moves];
    moves[index] = value;
    update({ ...draft, moves });
  }
  function focusNextEmptyMove(afterIndex: number) {
    for (let j = afterIndex + 1; j < 4; j++) {
      if (!draft.moves[j]) { requestAnimationFrame(() => moveRefs.current[j]?.focus()); return; }
    }
  }
  function applySet(s: PopularSet) {
    const nature = s.nature ?? draft.nature;
    const sp: SpSpread = (s.sp as SpSpread | undefined) ?? (usage?.topSpread as SpSpread | undefined) ?? {};
    update({ ...draft, ability: s.ability, item: s.item, moves: padMoves(s.moves), nature, sp, computedStats: recompute(sp, nature) });
  }
  async function addBenchmark() {
    const desc = benchmarkInput.trim();
    if (!desc) return;
    setBenchmarkAdding(true);
    try {
      const res = await aiFetch('/api/benchmark/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc, species: draft.species, mon: { species: draft.species, ability: draft.ability, item: draft.item, nature: draft.nature, sp: draft.sp, moves: draft.moves, computedStats: draft.computedStats } }) });
      if (res.ok) {
        const { benchmark } = (await res.json()) as { benchmark: Benchmark };
        update({ ...draft, benchmarks: [...draft.benchmarks, benchmark] });
        setBenchmarkInput('');
      }
    } finally { setBenchmarkAdding(false); benchmarkRef.current?.focus(); }
  }
  function removeBenchmark(id: string) { update({ ...draft, benchmarks: draft.benchmarks.filter((b) => b.id !== id) }); }
  async function optimize() {
    if (!baseStats) return;
    if (!draft.benchmarks.length) { setOptimizeError('Add at least one benchmark before optimizing.'); return; }
    setOptimizeLoading(true);
    setOptimizeError(null);
    setOptimizeReasoning(null);
    try {
      const res = await aiFetch('/api/optimize-sp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          species: draft.species,
          ability: draft.ability ?? '',
          item: draft.item ?? '',
          nature: draft.nature,
          moves: draft.moves.filter(Boolean),
          baseStats,
          benchmarks: draft.benchmarks,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setOptimizeError(data.error ?? 'Optimization failed.'); return; }
      const sp: SpSpread = {};
      for (const [k, v] of Object.entries(data.sp ?? {})) {
        if (typeof v === 'number' && v > 0) (sp as Record<string, number>)[k] = v;
      }
      update({ ...draft, sp, computedStats: recompute(sp, draft.nature) });
      setOptimizeReasoning(data.reasoning ?? null);
    } catch (e) {
      setOptimizeError((e as Error).message);
    } finally {
      setOptimizeLoading(false);
    }
  }
  async function submitPaste() {
    if (!pasteText.trim() || pasteLoading) return;
    setPasteLoading(true);
    setPasteError(null);
    const err = await onPasteImport(pasteText);
    if (err) { setPasteError(err); } else { setShowPaste(false); setPasteText(''); }
    setPasteLoading(false);
  }

  const moves = padMoves(draft.moves);

  const fieldLabel: React.CSSProperties = { fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: '#40406a', marginBottom: 5 };
  const fieldInput: React.CSSProperties = { background: 'rgba(4,4,14,0.85)', border: '1px solid rgba(99,102,241,0.16)', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 700, color: '#c0c0e4', cursor: 'pointer', width: '100%', outline: 'none', colorScheme: 'dark' };

  return (
    <div style={{ borderRadius: 14, border: '1.5px solid rgba(99,102,241,0.32)', background: 'rgba(12,12,28,0.85)', padding: 16, animation: 'slideInR 0.2s ease' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0, flex: 1 }}>
          <div style={{ background: 'radial-gradient(circle at 50% 65%, rgba(99,102,241,0.14), transparent 72%)', border: '1px solid rgba(99,102,241,0.16)', borderRadius: 14, width: 76, height: 76, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <MonSprite species={draft.species} size={68} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 21, fontWeight: 900, color: '#eaeaf8', letterSpacing: '-0.4px', whiteSpace: 'nowrap' }}>{draft.species}</span>
              {lists.speciesIsMega[draft.species] && <MegaBadge />}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
              {(lists.speciesTypes[draft.species] ?? []).map((t) => <TypePill key={t} type={t} />)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {loadingUsage && <span style={{ fontSize: 10, color: '#35355a' }}>loading…</span>}
              {usage && usage.usagePct > 0 && <span style={{ fontSize: 11, color: '#58588a', fontWeight: 700 }}>{usage.usagePct}% usage</span>}
              {draft.role && <span style={{ fontSize: 11, color: '#44446a', fontWeight: 600, fontStyle: 'italic' }}>{draft.role}</span>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', paddingTop: 2 }}>
          <SmBtn onClick={() => setShowPaste((s) => !s)} active={showPaste}>Paste</SmBtn>
          <SmBtn onClick={optimize} disabled={optimizeLoading || !baseStats}>{optimizeLoading ? 'Optimizing…' : 'Optimize'}</SmBtn>
        </div>
      </div>

      {/* Paste panel */}
      {showPaste && (
        <div style={{ marginBottom: 14, borderRadius: 10, border: '1px solid rgba(99,102,241,0.18)', background: 'rgba(5,5,15,0.8)', padding: 12 }}>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitPaste(); }}
            placeholder="Paste a Showdown-style set — replaces this slot"
            rows={6}
            style={{ width: '100%', borderRadius: 8, border: '1px solid rgba(99,102,241,0.16)', background: 'rgba(4,4,14,0.85)', padding: '10px 12px', fontFamily: "'Courier New', monospace", fontSize: 12, color: '#b0b0d0', outline: 'none', resize: 'vertical', display: 'block', colorScheme: 'dark' } as React.CSSProperties}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button onClick={submitPaste} disabled={pasteLoading || !pasteText.trim()} style={{ padding: '5px 16px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer', opacity: (pasteLoading || !pasteText.trim()) ? 0.5 : 1 }}>
              {pasteLoading ? 'Importing…' : 'Import set'}
            </button>
            <button onClick={() => { setShowPaste(false); setPasteText(''); setPasteError(null); }} style={{ fontSize: 12, color: '#50507a', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
            {pasteError && <span style={{ fontSize: 11, color: '#f87171' }}>{pasteError}</span>}
          </div>
        </div>
      )}

      {/* Optimize banners */}
      {optimizeError && (
        <div style={{ marginBottom: 10, borderRadius: 9, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(239,68,68,0.07)', padding: '8px 12px', fontSize: 11, color: '#fca5a5', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <span>Optimize failed: {optimizeError}</span>
          <button onClick={() => setOptimizeError(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
        </div>
      )}
      {optimizeReasoning && (
        <div style={{ marginBottom: 10, borderRadius: 9, border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.07)', padding: '8px 12px', fontSize: 11, color: '#a0a0e4', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ lineHeight: 1.5 }}>{optimizeReasoning}</span>
          <button onClick={() => setOptimizeReasoning(null)} style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
        </div>
      )}

      {/* Popular sets */}
      {usage?.sets && usage.sets.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <PopularSets sets={usage.sets} lists={lists} onApply={applySet} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>

        {/* Species */}
        <div>
          <div style={fieldLabel}>Species</div>
          <Combobox value={draft.species} onChange={changeSpecies} options={lists.species} placeholder="Species" renderOption={(name) => speciesOptionNode(name, lists)} />
        </div>

        {/* Both formes of a Mega-capable Pokémon */}
        {forms && (
          <MegaFormToggle forms={forms} current={draft.species} lists={lists} sp={draft.sp} nature={draft.nature} onSwitch={switchForme} />
        )}

        {/* Ability + Item */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
          <div>
            <div style={fieldLabel}>Ability</div>
            {abilityOptions.length <= 1 ? (
              <div style={fieldInput} title={lists.abilityDesc[draft.ability || abilityOptions[0]]}>{draft.ability || abilityOptions[0] || '—'}</div>
            ) : (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {abilityOptions.map((a) => (
                  <button
                    key={a}
                    onClick={() => update({ ...draft, ability: a })}
                    title={lists.abilityDesc[a]}
                    style={{
                      padding: '5px 11px', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                      border: `1px solid ${draft.ability === a ? '#6366f1' : 'rgba(99,102,241,0.22)'}`,
                      background: draft.ability === a ? 'rgba(99,102,241,0.16)' : 'rgba(4,4,14,0.75)',
                      color: draft.ability === a ? '#e4e4f8' : '#58588a',
                    }}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}
            <DescLine text={lists.abilityDesc[draft.ability || abilityOptions[0]]} />
          </div>
          <div>
            <div style={fieldLabel}>Item</div>
            <Combobox
              value={draft.item ?? ''}
              onChange={changeItem}
              options={itemOptions}
              placeholder="Item"
              title={lists.itemDesc[draft.item ?? '']}
              renderOption={(name, active) => itemOptionNode(name, lists, { pct: itemPct.get(name), active })}
            />
            <DescLine text={draft.item ? lists.itemDesc[draft.item] : undefined} />
          </div>
        </div>

        {/* Nature */}
        <div>
          <div style={fieldLabel}>Nature</div>
          <select value={draft.nature} onChange={(e) => changeNature(e.target.value)} style={fieldInput as React.CSSProperties}>
            {!isCompleteNature(draft.nature) && <option value={draft.nature}>{natureLabel(draft.nature)}</option>}
            {lists.natures.map((n) => <option key={n} value={n}>{natureLabel(n)}</option>)}
          </select>
        </div>

        {/* Moves */}
        <div>
          <div style={fieldLabel}>Moves</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            {[0, 1, 2, 3].map((i) => {
              const moveName = moves[i];
              const info = moveName ? lists.moveInfo[moveName] : null;
              const offLearnset = !!moveName && moveSections.notLearnable.has(moveName);
              return (
                <div key={i} style={{ background: 'rgba(4,4,14,0.85)', border: `1px solid ${offLearnset ? 'rgba(212,165,74,0.35)' : 'rgba(99,102,241,0.16)'}`, borderRadius: 8, padding: '4px 8px 5px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {info?.type && <MoveTypeTag type={info.type} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Combobox
                        value={moveName}
                        onChange={(val) => changeMove(i, val)}
                        options={moveSections.options}
                        placeholder={`Move ${i + 1}`}
                        title={info?.desc}
                        inputRef={(el) => { moveRefs.current[i] = el; }}
                        onAfterSelect={() => focusNextEmptyMove(i)}
                        renderOption={(name, active) => moveOptionNode(name, lists, { pct: moveSections.pct.get(name), active })}
                      />
                    </div>
                  </div>
                  <DescLine text={info?.desc} note={offLearnset ? 'Not in Gen 9 learnset' : undefined} style={{ marginTop: 2, paddingLeft: 2 }} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Stat Points */}
        <SpEditor
          sp={draft.sp}
          nature={draft.nature}
          baseStats={baseStats}
          onChange={(sp) => update({ ...draft, sp, computedStats: recompute(sp, draft.nature) })}
          onNatureChange={changeNature}
          nag={natureNag}
        />

        {/* Benchmarks */}
        <div>
          <div style={fieldLabel}>Benchmarks</div>
          {draft.benchmarks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {draft.benchmarks.map((b) => (
                <div key={b.id} style={{ border: `1px solid ${BENCH_BORDER[b.status]}`, background: BENCH_BG[b.status], borderRadius: 9, padding: '7px 10px', display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 900, color: BENCH_COLOR[b.status], flexShrink: 0, lineHeight: 1.4 }}>{BENCH_ICON[b.status]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#c0c0e4' }}>{b.description}</div>
                    {b.detail && <div style={{ fontFamily: "'Courier New', monospace", fontSize: 10, color: '#50507a', marginTop: 2 }}>{b.detail}</div>}
                  </div>
                  <button onClick={() => removeBenchmark(b.id)} style={{ background: 'none', border: 'none', color: '#35355a', fontSize: 10, cursor: 'pointer', flexShrink: 0, padding: 0, lineHeight: 1.4 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={benchmarkRef}
              type="text"
              value={benchmarkInput}
              onChange={(e) => setBenchmarkInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBenchmark(); } }}
              placeholder='e.g. "OHKOs max HP Garchomp with Earthquake"'
              style={{ flex: 1, minWidth: 0, background: 'rgba(4,4,14,0.85)', border: '1px solid rgba(99,102,241,0.16)', borderRadius: 8, padding: '7px 10px', fontSize: 11, color: '#c0c0e4', outline: 'none', fontWeight: 600, colorScheme: 'dark' } as React.CSSProperties}
            />
            <button
              onClick={addBenchmark}
              disabled={benchmarkAdding || !benchmarkInput.trim()}
              style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'rgba(99,102,241,0.07)', color: '#7070a8', fontSize: 11, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', opacity: (benchmarkAdding || !benchmarkInput.trim()) ? 0.5 : 1 }}
            >
              {benchmarkAdding ? '…' : 'Add'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#35355a', marginTop: 5, fontWeight: 600 }}>Benchmarks re-evaluate as you edit the set.</div>
        </div>

      </div>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function SmBtn({ onClick, disabled, active, children }: { onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        borderRadius: 7,
        border: `1px solid ${active ? '#6366f1' : 'rgba(99,102,241,0.22)'}`,
        background: active ? 'rgba(99,102,241,0.14)' : 'rgba(99,102,241,0.07)',
        color: active ? '#c0c0f0' : '#7070a8',
        fontSize: 11,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: 700,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
