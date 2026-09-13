'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import type { TeamMon } from '@/lib/benchmarks/types';
import { natureLabel, isCompleteNature, type SpSpread, type StatSpread } from '@/lib/calc/sp';
import { padMoves } from '@/lib/moves';
import Combobox from '@/components/Combobox';
import type { PopularSet } from '@/lib/data/usage';
import { useUsage, usageSortedItems } from '@/hooks/useUsage';
import { useLearnset, moveOptionsFor } from '@/hooks/useLearnset';
import type { CalcMonSet, CalcScreenState, CompareOpponent } from '@/lib/ai/types';
import type { FormLists } from '@/lib/data/champions';
import CompareStrip from '@/components/CompareStrip';
import SpEditor from '@/components/SpEditor';
import MegaFormToggle from '@/components/MegaFormToggle';
import { megaFormsFor, abilityForForme } from '@/lib/megaForms';
import { useRuleset } from '@/components/RulesetProvider';
import PopularSets from '@/components/PopularSets';
import { MonSprite, TypePill, MoveTypeTag, MegaBadge, DescLine, moveOptionNode, itemOptionNode, speciesOptionNode } from '@/components/ui';

type MonSet = CalcMonSet;

interface CalcResult {
  rolls: number[];
  minDamage: number;
  maxDamage: number;
  minPct: number;
  maxPct: number;
  defenderMaxHP: number;
  koChance: string;
  desc: string;
  flags: string[];
}

interface CalcResponse {
  result: CalcResult;
  attackerStats: StatSpread;
  defenderStats: StatSpread;
}

type MoveResultMap = Record<string, CalcResponse>;

const WEATHERS = ['', 'Sun', 'Rain', 'Sand', 'Snow'];
const TERRAINS = ['', 'Electric', 'Grassy', 'Psychic', 'Misty'];

export const DEFAULT_CALC_STATE: CalcScreenState = {
  attacker: {
    species: 'Staraptor', ability: 'Reckless', item: 'Choice Scarf', nature: 'Adamant',
    sp: { atk: 32 }, moves: ['Brave Bird', 'Close Combat', 'Final Gambit', 'U-turn'],
  },
  defender: {
    species: 'Dragonite-Mega', ability: 'Multiscale', item: '', nature: 'Modest',
    sp: {}, moves: ['Hurricane', 'Thunderbolt', 'Tailwind', 'Protect'],
  },
  field: { gameType: 'Doubles', weather: '', terrain: '', isCrit: false },
};

/**
 * The attacker/defender/field settings are owned by Workspace (see CalcScreenState) so the
 * assistant can read and edit them and they survive tab switches; results stay local.
 * `runToken` increments when something outside (e.g. the assistant) wants "Calc All" to run.
 */
export default function DamageCalcView({ lists, team, state, onChange, runToken }: {
  lists: FormLists;
  team?: TeamMon[] | null;
  state: CalcScreenState;
  onChange: (patch: Partial<CalcScreenState>) => void;
  runToken: number;
}) {
  const { ruleset } = useRuleset();
  const { attacker, defender, field } = state;
  const { gameType, weather, terrain, isCrit } = field;
  const [moveResults, setMoveResults] = useState<MoveResultMap>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fillSide, setFillSide] = useState<'atk' | 'def'>('def');

  function clearResults() { setMoveResults({}); setActiveKey(null); setError(null); }
  function setAttacker(s: MonSet) { onChange({ attacker: s }); clearResults(); }
  function setDefender(s: MonSet) { onChange({ defender: s }); clearResults(); }
  function setField(patch: Partial<CalcScreenState['field']>) { onChange({ field: { ...field, ...patch } }); clearResults(); }

  // Results are tied to the sets/field they were computed from; any outside change invalidates them.
  const settingsKey = JSON.stringify(state);
  const [prevSettingsKey, setPrevSettingsKey] = useState(settingsKey);
  if (settingsKey !== prevSettingsKey) {
    setPrevSettingsKey(settingsKey);
    setMoveResults({});
    setActiveKey(null);
  }

  // Outside "Calc All" requests (assistant: updateCalc with run:true).
  useEffect(() => {
    if (runToken > 0) calcAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  function buildPayload(atkSet: MonSet, defSet: MonSet, moveName: string) {
    return {
      attacker: { species: atkSet.species, ability: atkSet.ability, item: atkSet.item, nature: atkSet.nature, sp: atkSet.sp },
      defender: { species: defSet.species, ability: defSet.ability, item: defSet.item, nature: defSet.nature, sp: defSet.sp },
      move: { name: moveName, isCrit },
      field: { gameType, weather: weather || undefined, terrain: terrain || undefined },
      regulation: ruleset,
    };
  }

  async function calcMove(moveName: string, side: 'atk' | 'def') {
    if (!moveName) return;
    const key = `${side}:${moveName}`;
    setActiveKey(key);
    setLoading(true);
    setError(null);
    const atkSet = side === 'atk' ? attacker : defender;
    const defSet = side === 'atk' ? defender : attacker;
    try {
      const r = await fetch('/api/calc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(atkSet, defSet, moveName)) });
      const data = await r.json();
      if (!r.ok) { setError(data.error + (data.issues ? ': ' + data.issues.map((i: { message: string }) => i.message).join(' ') : '')); }
      else { setMoveResults((prev) => ({ ...prev, [key]: data })); }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function calcAll() {
    const pairs = [
      ...attacker.moves.filter(Boolean).map((m) => ({ m, side: 'atk' as const })),
      ...defender.moves.filter(Boolean).map((m) => ({ m, side: 'def' as const })),
    ];
    if (!pairs.length) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(pairs.map(async ({ m, side }) => {
        const atkSet = side === 'atk' ? attacker : defender;
        const defSet = side === 'atk' ? defender : attacker;
        try {
          const r = await fetch('/api/calc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(atkSet, defSet, m)) });
          if (!r.ok) return null;
          const data: CalcResponse = await r.json();
          return [`${side}:${m}`, data] as const;
        } catch { return null; }
      }));
      const newResults = Object.fromEntries((entries.filter((e) => e !== null) as [string, CalcResponse][]));
      setMoveResults(newResults);
      const firstAtkMove = attacker.moves.find(Boolean);
      if (firstAtkMove && newResults[`atk:${firstAtkMove}`]) setActiveKey(`atk:${firstAtkMove}`);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  const activeResp = activeKey ? moveResults[activeKey] : null;

  const [sidebarOpen, setSidebarOpen] = useState(true);

  function addToCalc(mon: TeamMon, role: 'atk' | 'def') {
    const s: MonSet = {
      species: mon.species, ability: mon.ability ?? '', item: mon.item ?? '',
      nature: mon.nature, sp: mon.sp,
      moves: padMoves(mon.moves),
    };
    if (role === 'atk') setAttacker(s);
    else setDefender(s);
  }

  const filledTeam = team?.filter((m): m is TeamMon => m !== null) ?? [];
  const focus = fillSide === 'def' ? attacker : defender;

  function pickOpponent(opp: CompareOpponent) {
    const s: MonSet = { species: opp.species, ability: opp.ability, item: opp.item, nature: opp.nature || 'Hardy', sp: opp.sp, moves: padMoves(opp.moves) };
    if (fillSide === 'def') setDefender(s);
    else setAttacker(s);
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', animation: 'fadeUp 0.18s ease' }}>

      {/* Team sidebar (LEFT) */}
      {filledTeam.length > 0 && (
        <TeamSidebar team={filledTeam} onSelect={addToCalc} isOpen={sidebarOpen} onToggle={() => setSidebarOpen((s) => !s)} />
      )}

      {/* Main calc area */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Attacker / Defender panels. minmax(0, 1fr), not 1fr: a bare 1fr column refuses to shrink
          below its content's min width, and the popular-set chip strip and nowrap description
          lines inside each panel are far wider than half the page, so the columns would blow
          past the viewport and push the defender off-screen. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
        <SetEditor
          title="Attacker" side="atk" set={attacker}
          onChange={setAttacker}
          lists={lists} moveResults={moveResults} activeKey={activeKey}
          onMoveClick={(m) => calcMove(m, 'atk')}
        />
        <SetEditor
          title="Defender" side="def" set={defender}
          onChange={setDefender}
          lists={lists} moveResults={moveResults} activeKey={activeKey}
          onMoveClick={(m) => calcMove(m, 'def')}
        />
      </div>

      {/* Dynamic matchups: threats chosen for whichever side you are building around */}
      {focus.species && lists.speciesStats[focus.species] && (
        <CompareStrip
          mode="calc"
          focus={[{ species: focus.species, ability: focus.ability, item: focus.item, nature: focus.nature, sp: focus.sp, moves: focus.moves }]}
          teamSpecies={filledTeam.map((m) => m.species).filter((s) => s !== focus.species)}
          title={<>Matchups for {focus.species}</>}
          accent={fillSide === 'def' ? '#93c5fd' : '#f87171'}
          onPick={pickOpponent}
          headerExtra={
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 9, color: '#50508a', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px' }}>click fills</span>
              {(['def', 'atk'] as const).map((side) => {
                const active = fillSide === side;
                const color = side === 'atk' ? '#f87171' : '#93c5fd';
                return (
                  <button key={side} onClick={() => setFillSide(side)} style={{ padding: '2px 8px', borderRadius: 6, border: `1px solid ${active ? color : 'rgba(99,102,241,0.2)'}`, background: active ? `${color}22` : 'transparent', color: active ? color : '#50508a', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>
                    {side === 'atk' ? '⚔ Attacker' : '🛡 Defender'}
                  </button>
                );
              })}
            </div>
          }
        />
      )}

      {/* Field options */}
      <div style={{ borderRadius: 12, border: '1px solid rgba(99,102,241,0.18)', background: 'rgba(12,12,28,0.85)', padding: '11px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <FieldRow label="Format">
            <CalcSelect value={gameType} onChange={(v) => setField({ gameType: v as 'Doubles' | 'Singles' })}>
              <option>Doubles</option>
              <option>Singles</option>
            </CalcSelect>
          </FieldRow>
          <FieldRow label="Weather">
            <CalcSelect value={weather} onChange={(v) => setField({ weather: v })}>
              {WEATHERS.map((w) => <option key={w} value={w}>{w || '—'}</option>)}
            </CalcSelect>
          </FieldRow>
          <FieldRow label="Terrain">
            <CalcSelect value={terrain} onChange={(v) => setField({ terrain: v })}>
              {TERRAINS.map((t) => <option key={t} value={t}>{t || '—'}</option>)}
            </CalcSelect>
          </FieldRow>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: '#6060a0', cursor: 'pointer' }}>
            <input type="checkbox" checked={isCrit} onChange={(e) => setField({ isCrit: e.target.checked })} style={{ cursor: 'pointer', accentColor: '#6366f1' }} />
            Crit
          </label>
          <div style={{ flex: 1 }} />
          <button
            onClick={calcAll}
            disabled={loading}
            style={{ padding: '6px 20px', borderRadius: 9, background: '#6366f1', color: 'white', border: 'none', fontSize: 13, fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Calculating…' : 'Calc All'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ borderRadius: 9, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(239,68,68,0.07)', padding: '10px 14px', fontSize: 12, color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {activeResp && (
        <ResultPanel
          result={activeResp.result}
          activeKey={activeKey}
          attacker={attacker}
          defender={defender}
        />
      )}

      </div>{/* end main calc area */}

    </div>
  );
}

// ─── Set editor ───────────────────────────────────────────────────────────────

function SetEditor({ title, side, set, onChange, lists, moveResults, activeKey, onMoveClick }: {
  title: string;
  side: 'atk' | 'def';
  set: MonSet;
  onChange: (s: MonSet) => void;
  lists: FormLists;
  moveResults: MoveResultMap;
  activeKey: string | null;
  onMoveClick: (m: string) => void;
}) {
  const { usage } = useUsage(set.species);
  const { learnset } = useLearnset(set.species);
  const abilityOptions = lists.speciesAbilities[set.species]?.length ? lists.speciesAbilities[set.species] : lists.abilities;
  const itemOptions = usageSortedItems(lists.items, usage?.items ?? []);
  const itemPct = new Map((usage?.items ?? []).map((e) => [e.name, e.pct]));
  const moveSections = moveOptionsFor(lists.moves, usage?.moves, learnset);

  const topSpreadAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!usage?.topSpread) return;
    if (topSpreadAppliedRef.current === set.species) return;
    topSpreadAppliedRef.current = set.species;
    onChange({ ...set, sp: usage.topSpread as SpSpread });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage]);

  const isAtk = side === 'atk';
  const accentColor = isAtk ? '#f87171' : '#93c5fd';
  const panelBorder = isAtk ? 'rgba(248,113,113,0.28)' : 'rgba(147,197,253,0.22)';
  const spriteBorder = isAtk ? 'rgba(248,113,113,0.14)' : 'rgba(147,197,253,0.14)';
  const spriteGrad = isAtk ? 'rgba(248,113,113,0.1)' : 'rgba(147,197,253,0.1)';

  const forms = megaFormsFor(set.species, set.item, lists);
  function changeSpecies(species: string) {
    const abilities = lists.speciesAbilities[species] ?? [];
    onChange({ ...set, species, ability: abilities[0] ?? '', item: '', moves: ['', '', '', ''] });
  }
  function switchForme(species: string) {
    if (!forms) return;
    onChange({ ...set, species, item: forms.stone, ability: abilityForForme(set.ability, species, lists) });
  }
  function changeItem(item: string) {
    const baseSpecies = forms ? forms.base : set.species;
    const mega = lists.megaOfStone[item];
    const target = mega && lists.megaBase[mega] === baseSpecies ? mega : baseSpecies;
    if (target === set.species) { onChange({ ...set, item }); return; }
    onChange({ ...set, species: target, item, ability: abilityForForme(set.ability, target, lists) });
  }
  function setMove(index: number, value: string) {
    const moves = padMoves(set.moves);
    moves[index] = value;
    onChange({ ...set, moves });
  }
  function applySet(s: PopularSet) {
    onChange({ ...set, ability: s.ability, item: s.item, moves: padMoves(s.moves), ...(s.nature ? { nature: s.nature } : {}), ...(s.sp ? { sp: s.sp as SpSpread } : {}) });
  }

  const moves = padMoves(set.moves);
  const types = lists.speciesTypes[set.species] ?? [];
  const isMega = lists.speciesIsMega[set.species];

  const fieldLabel: React.CSSProperties = { fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a', marginBottom: 4 };
  const fieldBox: React.CSSProperties = { background: 'rgba(4,4,14,0.85)', border: '1px solid rgba(99,102,241,0.16)', borderRadius: 7, padding: '6px 9px', fontSize: 11, fontWeight: 700, color: '#c0c0e4', outline: 'none', width: '100%', colorScheme: 'dark' };

  return (
    <div style={{ borderRadius: 14, border: `1.5px solid ${panelBorder}`, background: 'rgba(12,12,28,0.85)', padding: 14, minWidth: 0 }}>
      {/* Panel header */}
      <div style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '1.2px', color: accentColor, marginBottom: 11 }}>
        {isAtk ? '⚔' : '🛡'} {title}
      </div>

      {/* Species header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
        <div style={{ background: `radial-gradient(circle at 50% 65%, ${spriteGrad}, transparent 70%)`, border: `1px solid ${spriteBorder}`, borderRadius: 12, width: 60, height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <MonSprite species={set.species} size={54} plain />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 900, color: '#eaeaf8', whiteSpace: 'nowrap' }}>{set.species}</span>
            {isMega && <MegaBadge small />}
            {forms && <MegaFormToggle small forms={forms} current={set.species} onSwitch={switchForme} />}
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {types.map((t) => <TypePill key={t} type={t} small />)}
          </div>
        </div>
      </div>

      {/* Species picker (collapsed to combobox) */}
      <div style={{ marginBottom: 10 }}>
        <Combobox value={forms ? forms.base : set.species} onChange={changeSpecies} options={lists.species} placeholder="Species" renderOption={(name) => speciesOptionNode(name, lists)} />
      </div>

      {/* Ability + Item */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 6, marginBottom: 11 }}>
        <div>
          <div style={fieldLabel}>Ability</div>
          <Combobox
            value={set.ability}
            onChange={(ability) => onChange({ ...set, ability })}
            options={abilityOptions}
            placeholder="Ability"
            title={lists.abilityDesc[set.ability]}
            renderOption={(name, active) => (
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span>{name}</span>
                {lists.abilityDesc[name] && <span style={{ fontSize: 10, fontWeight: 500, color: active ? 'rgba(255,255,255,0.72)' : '#6a6a9a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lists.abilityDesc[name]}</span>}
              </span>
            )}
          />
          <DescLine text={lists.abilityDesc[set.ability]} />
        </div>
        <div>
          <div style={fieldLabel}>Item</div>
          <Combobox
            value={set.item}
            onChange={changeItem}
            options={itemOptions}
            placeholder="Item"
            title={lists.itemDesc[set.item]}
            renderOption={(name, active) => itemOptionNode(name, lists, { pct: itemPct.get(name), active })}
          />
          <DescLine text={lists.itemDesc[set.item]} />
        </div>
      </div>

      {/* Nature */}
      <div style={{ marginBottom: 11 }}>
        <div style={fieldLabel}>Nature</div>
        <select value={set.nature} onChange={(e) => onChange({ ...set, nature: e.target.value })} style={fieldBox as React.CSSProperties}>
          {!isCompleteNature(set.nature) && <option value={set.nature}>{natureLabel(set.nature)}</option>}
          {lists.natures.map((n) => <option key={n} value={n}>{natureLabel(n)}</option>)}
        </select>
      </div>

      {/* Moves */}
      <div style={{ marginBottom: 11 }}>
        <div style={fieldLabel}>Moves — click to calculate</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {moves.map((moveName, i) => {
            const key = moveName ? `${side}:${moveName}` : null;
            const result = key ? moveResults[key]?.result : null;
            const isActive = key !== null && key === activeKey;
            const info = moveName ? lists.moveInfo[moveName] : null;
            const offLearnset = !!moveName && moveSections.notLearnable.has(moveName);
            return (
              <div
                key={i}
                style={{
                  background: isActive ? (isAtk ? 'rgba(248,113,113,0.12)' : 'rgba(147,197,253,0.1)') : 'rgba(4,4,14,0.85)',
                  border: `1px solid ${isActive ? (isAtk ? 'rgba(248,113,113,0.3)' : 'rgba(147,197,253,0.25)') : offLearnset ? 'rgba(212,165,74,0.35)' : 'rgba(99,102,241,0.13)'}`,
                  borderRadius: 8,
                  padding: '5px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                }}
              >
                {info?.type && <MoveTypeTag type={info.type} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Combobox
                    value={moveName}
                    onChange={(v) => setMove(i, v)}
                    options={moveSections.options}
                    placeholder={`Move ${i + 1}`}
                    title={info?.desc}
                    renderOption={(name, active) => moveOptionNode(name, lists, { pct: moveSections.pct.get(name), active })}
                  />
                  <DescLine text={info?.desc} note={offLearnset ? 'Not in Gen 9 learnset' : undefined} style={{ marginTop: 2 }} />
                </div>
                {moveName && (
                  <button
                    onClick={() => onMoveClick(moveName)}
                    style={{
                      flexShrink: 0,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: "'Courier New', monospace",
                      fontSize: 10,
                      fontWeight: 700,
                      color: result ? (isAtk ? '#fca5a5' : '#93c5fd') : '#40406a',
                      padding: '0 2px',
                      whiteSpace: 'nowrap',
                    }}
                    title={result ? `${result.minPct}–${result.maxPct}%` : 'Calculate'}
                  >
                    {result ? `${result.minPct}–${result.maxPct}%` : '→'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* SP */}
      <div style={{ marginBottom: usage?.sets?.length ? 11 : 0 }}>
        <SpEditor
          compact
          sp={set.sp}
          nature={set.nature}
          baseStats={lists.speciesStats[set.species]}
          onChange={(sp) => onChange({ ...set, sp })}
          onNatureChange={(nature) => onChange({ ...set, nature })}
        />
      </div>

      {/* Popular sets */}
      {usage?.sets && usage.sets.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(99,102,241,0.12)', paddingTop: 10 }}>
          <PopularSets sets={usage.sets} lists={lists} onApply={applySet} small />
        </div>
      )}
    </div>
  );
}

// ─── Team sidebar ─────────────────────────────────────────────────────────────

function TeamSidebar({ team, onSelect, isOpen, onToggle }: {
  team: TeamMon[];
  onSelect: (mon: TeamMon, role: 'atk' | 'def') => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [popover, setPopover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (popover === null) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setPopover(null);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popover]);

  return (
    <div ref={ref} style={{
      flexShrink: 0, borderRadius: 12, border: '1px solid rgba(99,102,241,0.18)',
      background: 'rgba(12,12,28,0.85)',
      width: isOpen ? 150 : 30, transition: 'width 0.2s ease',
      display: 'flex', flexDirection: 'column', position: 'relative',
    }}>
      {isOpen ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 9px 6px' }}>
            <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a' }}>My Team</span>
            <button onClick={onToggle} style={{ background: 'none', border: 'none', color: '#40406a', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>‹</button>
          </div>
          <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {team.map((mon) => (
              <div key={mon.slot} style={{ position: 'relative' }}>
                <button
                  onClick={() => setPopover(popover === mon.slot ? null : mon.slot)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                    borderRadius: 8, border: `1px solid ${popover === mon.slot ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.14)'}`,
                    background: popover === mon.slot ? 'rgba(99,102,241,0.14)' : 'rgba(4,4,14,0.7)',
                    padding: '5px 7px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                  }}
                >
                  <MonSprite species={mon.species} size={28} plain />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#b0b0d4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {mon.species}
                  </span>
                </button>
                {popover === mon.slot && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                    marginTop: 3, borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)',
                    background: 'rgba(10,10,26,0.98)', padding: 5,
                    display: 'flex', flexDirection: 'column', gap: 4,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                  }}>
                    <button onClick={() => { onSelect(mon, 'atk'); setPopover(null); }}
                      style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.1)', color: '#fca5a5', fontSize: 11, fontWeight: 800, cursor: 'pointer', textAlign: 'left' }}>
                      ⚔ Attacker
                    </button>
                    <button onClick={() => { onSelect(mon, 'def'); setPopover(null); }}
                      style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(147,197,253,0.3)', background: 'rgba(147,197,253,0.1)', color: '#93c5fd', fontSize: 11, fontWeight: 800, cursor: 'pointer', textAlign: 'left' }}>
                      🛡 Defender
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10 }}>
          <button onClick={onToggle} style={{
            background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.22)',
            color: '#6366f1', cursor: 'pointer', padding: '6px 4px', borderRadius: 7,
            fontSize: 11, fontWeight: 800, writingMode: 'vertical-rl', textOrientation: 'mixed',
            letterSpacing: '0.5px', width: 22,
          } as React.CSSProperties}>Team</button>
        </div>
      )}
    </div>
  );
}

// ─── Result panel ─────────────────────────────────────────────────────────────

function ResultPanel({ result, activeKey, attacker, defender }: {
  result: CalcResult;
  activeKey: string | null;
  attacker: MonSet;
  defender: MonSet;
}) {
  const moveName = activeKey?.split(':').slice(1).join(':') ?? '';
  const isAtkMove = activeKey?.startsWith('atk:');
  const atkSpecies = isAtkMove ? attacker.species : defender.species;
  const defSpecies = isAtkMove ? defender.species : attacker.species;

  return (
    <div style={{ borderRadius: 12, border: '1px solid rgba(251,191,36,0.2)', background: 'rgba(12,12,28,0.85)', padding: 14 }}>
      <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.2px', color: '#50508a', marginBottom: 11 }}>
        Result · {moveName} ({isAtkMove ? 'attacker → defender' : 'defender → attacker'})
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: '#fca5a5' }}>{atkSpecies}</span>
        <span style={{ color: '#35355a', fontSize: 16 }}>→</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: '#93c5fd' }}>{defSpecies}</span>
      </div>

      {/* Code block */}
      <div style={{ background: 'rgba(4,4,14,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 9, padding: '10px 13px', marginBottom: 12, fontFamily: "'Courier New', monospace", lineHeight: 1.9, fontSize: 12, color: '#c0c0e4' }}>
        <div>
          <span style={{ color: '#50508a' }}>Range: </span>
          <span style={{ color: '#fbbf24', fontWeight: 700 }}>{result.minDamage}–{result.maxDamage} ({result.minPct}–{result.maxPct}%)</span>
        </div>
        {result.koChance && (
          <div>
            <span style={{ color: '#50508a' }}>KO:    </span>
            <span style={{ color: '#e4e4f0', fontWeight: 700 }}>{result.koChance}</span>
          </div>
        )}
        <div style={{ marginTop: 3, fontSize: 10, color: '#40406a' }}>{result.rolls.join(' ')}</div>
      </div>

      {/* HP bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a' }}>Damage on HP bar</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#fbbf24' }}>{result.minPct}% – {result.maxPct}%</span>
        </div>
        <div style={{ height: 14, borderRadius: 7, background: 'rgba(255,255,255,0.04)', position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.04)' }}>
          {/* Remaining HP */}
          <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(90deg, rgba(99,102,241,0.25) ${100 - result.minPct}%, rgba(255,255,255,0.02) ${100 - result.minPct}%)` }} />
          {/* Damage range band */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${result.minPct}%`, width: `${result.maxPct - result.minPct}%`, background: 'linear-gradient(90deg, rgba(248,113,113,0.65), rgba(251,191,36,0.65))' }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${result.minPct}%`, width: 2, background: '#f87171' }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${result.maxPct}%`, width: 2, background: '#fbbf24' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
          <span style={{ fontSize: 9, color: '#35355a', fontWeight: 600 }}>0%</span>
          <span style={{ fontSize: 9, color: '#35355a', fontWeight: 600 }}>100%</span>
        </div>
      </div>

      {/* Roll histogram */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a', marginBottom: 5 }}>16 rolls</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 32 }}>
          {result.rolls.map((d, i) => {
            const max = Math.max(...result.rolls, 1);
            return <div key={i} title={String(d)} style={{ flex: 1, borderRadius: '2px 2px 0 0', background: 'rgba(99,102,241,0.5)', height: `${(d / max) * 100}%` }} />;
          })}
        </div>
      </div>

      {result.flags.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.flags.map((f, i) => (
            <div key={i} style={{ borderRadius: 7, border: '1px solid rgba(251,191,36,0.25)', background: 'rgba(180,130,20,0.08)', padding: '5px 9px', fontSize: 11, color: '#fbbf24' }}>
              ⚠ {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#40406a' }}>{label}</span>
      {children}
    </div>
  );
}

function CalcSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ background: 'rgba(4,4,14,0.85)', border: '1px solid rgba(99,102,241,0.16)', borderRadius: 7, padding: '4px 8px', fontSize: 12, color: '#c0c0e4', outline: 'none', cursor: 'pointer', fontWeight: 700, colorScheme: 'dark' } as React.CSSProperties}
    >
      {children}
    </select>
  );
}

