/**
 * Champions damage/stat engine — the single source of every number in the app.
 *
 * Thin wrapper over the vendored `@smogon/calc` using generation 0 (Pokémon Champions). Claude never
 * estimates a number; it calls these functions. Champions specifics handled here:
 *   - SP is passed through the calc's `evs` field (gen 0); IVs ignored (always 31); level 50.
 *   - Terastallization is illegal in Champions — `calcDamage` rejects any Tera input before running.
 *   - Speed ties (equal Spe) are flagged, never silently resolved.
 *   - Multiscale-at-full-HP and other assumptions are surfaced as flags for Claude to relay.
 */
import { calculate, Pokemon, Move, Field, Generations, toID } from '@smogon/calc';
import type { GenerationNum } from '@smogon/calc';
import type { Stat, SpSpread, StatSpread } from './sp';
import { speciesOverrides, moveOverrides } from '@/lib/data/champions';

export const CHAMPIONS_GEN = 0 as GenerationNum; // 0 = Pokémon Champions in @smogon/calc

type Gen = ReturnType<typeof Generations.get>;
let _gen: Gen | null = null;
export function championsGen(): Gen {
  return (_gen ??= Generations.get(CHAMPIONS_GEN));
}

export class TeraRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeraRejectedError';
  }
}

export interface MonInput {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  /** Stat Points (0–32 each, ≤66 total). Passed to the calc as `evs` for gen 0. */
  sp?: SpSpread;
  boosts?: Partial<Record<Stat, number>>;
  curHP?: number;
  status?: '' | 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox';
  /** Illegal in Champions. If set, the calc is rejected before running. */
  teraType?: string;
}

export interface MoveInput {
  name: string;
  isCrit?: boolean;
  hits?: number;
  timesUsed?: number;
}

export interface SideInput {
  isReflect?: boolean;
  isLightScreen?: boolean;
  isAuroraVeil?: boolean;
  isHelpingHand?: boolean;
  isProtected?: boolean;
  isSR?: boolean;
  spikes?: number;
  isTailwind?: boolean;
}

export interface FieldInput {
  gameType?: 'Singles' | 'Doubles';
  weather?: string;
  terrain?: string;
  isGravity?: boolean;
  isTrickRoom?: boolean;
  attackerSide?: SideInput;
  defenderSide?: SideInput;
}

export interface CalcResult {
  /** The 16 damage rolls (ascending), totalled across hits for multi-hit moves. */
  rolls: number[];
  minDamage: number;
  maxDamage: number;
  minPct: number;
  maxPct: number;
  defenderMaxHP: number;
  koChance: string;
  /** Smogon-style result line, e.g. "32+ Atk Reckless Staraptor Brave Bird vs. …: 57-67 -- guaranteed 3HKO". */
  desc: string;
  /** Non-numeric caveats the UI/Claude must surface: speed ties, Multiscale assumption, etc. */
  flags: string[];
}

function assertNoTera(...mons: MonInput[]): void {
  for (const m of mons) {
    if (m.teraType) {
      throw new TeraRejectedError(
        `Terastallization is not legal in Pokémon Champions (teraType="${m.teraType}" on ${m.species}). Reject before running any calc.`,
      );
    }
  }
}

function buildMon(mon: MonInput): Pokemon {
  // The constructor's option types are branded; this adapter boundary intentionally passes plain
  // strings/objects. `sp` is supplied via `evs` because gen 0 reads SP from that field.
  const opts: Record<string, unknown> = {
    level: 50,
    ability: mon.ability,
    item: mon.item,
    nature: mon.nature,
    evs: mon.sp,
    boosts: mon.boosts,
  };
  if (mon.curHP !== undefined) opts.curHP = mon.curHP;
  if (mon.status) opts.status = mon.status;
  // Species added by a later regulation are not in the gen-0 dex; the constructor merges `overrides`
  // over its (empty) lookup, so grafted data flows through the same stat/damage code as native entries.
  const gen = championsGen();
  if (!gen.species.get(toID(mon.species))) {
    const overrides = speciesOverrides(mon.species);
    if (!overrides) throw new Error(`${mon.species} is not in the Champions dex.`);
    opts.overrides = overrides;
  }
  return new Pokemon(gen, mon.species, opts as unknown as ConstructorParameters<typeof Pokemon>[2]);
}

/** Final Champions stats (Level 50, IV 31) for a set. Uses the engine, so it always matches calcs. */
export function computeStats(mon: MonInput): StatSpread {
  const p = buildMon(mon);
  return {
    hp: p.maxHP(),
    atk: p.rawStats.atk,
    def: p.rawStats.def,
    spa: p.rawStats.spa,
    spd: p.rawStats.spd,
    spe: p.rawStats.spe,
  };
}

// ---- speed comparison ----

export interface SpeedMonInput extends MonInput {
  /** Display label, e.g. "Slot 2 Garchomp" or "opposing Weavile". Defaults to species. */
  label?: string;
  /** Speed stat stage, −6…+6. */
  stage?: number;
  paralyzed?: boolean;
  /** Whether this side's Tailwind is up. */
  tailwind?: boolean;
}

export interface SpeedEntryResult {
  label: string;
  species: string;
  /** Final Speed stat (base + SP + nature), before field modifiers. */
  stat: number;
  /** Speed after stages, paralysis, Choice Scarf, and Tailwind. */
  effective: number;
  modifiers: string[];
}

export interface SpeedComparisonResult {
  /** Entries in move order: index 0 acts first (Trick Room already accounted for). */
  order: SpeedEntryResult[];
  trickRoom: boolean;
  /** Speed-tie warnings — same effective Speed means 50/50 move order. */
  flags: string[];
}

function stageMultiplier(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

/**
 * Engine-computed move-order comparison. This is the only sanctioned source for "X outspeeds Y"
 * claims — the AI must never rank speeds from memory. Mirrors the SpeedTierView math exactly.
 */
export function compareSpeed(mons: SpeedMonInput[], opts?: { trickRoom?: boolean }): SpeedComparisonResult {
  const trickRoom = !!opts?.trickRoom;
  const entries: SpeedEntryResult[] = mons.map((m) => {
    const stat = computeStats(m).spe;
    const modifiers: string[] = [];
    let s = stat;
    if (m.stage) {
      s = Math.floor(s * stageMultiplier(Math.max(-6, Math.min(6, m.stage))));
      modifiers.push(`stage ${m.stage > 0 ? '+' : ''}${m.stage}`);
    }
    if (m.paralyzed) {
      s = Math.floor(s * 0.5);
      modifiers.push('paralyzed');
    }
    if (m.item === 'Choice Scarf') {
      s = Math.floor(s * 1.5);
      modifiers.push('Choice Scarf');
    }
    if (m.tailwind) {
      s = s * 2;
      modifiers.push('Tailwind');
    }
    return { label: m.label ?? m.species, species: m.species, stat, effective: Math.floor(s), modifiers };
  });

  const order = [...entries].sort((a, b) =>
    trickRoom ? a.effective - b.effective : b.effective - a.effective,
  );

  const flags: string[] = [];
  const bySpeed = new Map<number, string[]>();
  for (const e of order) {
    const group = bySpeed.get(e.effective) ?? [];
    group.push(e.label);
    bySpeed.set(e.effective, group);
  }
  for (const [spe, labels] of bySpeed) {
    if (labels.length > 1) {
      flags.push(`Speed tie at ${spe}: ${labels.join(' / ')} — move order is 50/50.`);
    }
  }
  return { order, trickRoom, flags };
}

function normalizeRolls(damage: number | number[] | number[][]): number[] {
  if (typeof damage === 'number') return [damage];
  if (damage.length === 0) return [];
  if (typeof damage[0] === 'number') return damage as number[];
  // Multi-hit / multi-turn: damage[hit][rollIndex]. Total per roll index across hits.
  const matrix = damage as number[][];
  const rolls = matrix[0].map((_, i) => matrix.reduce((sum, row) => sum + (row[i] ?? 0), 0));
  return rolls;
}

function collectFlags(attacker: Pokemon, defender: Pokemon, result: ReturnType<typeof calculate>): string[] {
  const flags: string[] = [];
  if (attacker.stats.spe === defender.stats.spe) {
    flags.push(
      `Speed tie: both at ${attacker.stats.spe} Spe — turn order is 50/50 and is not resolved. ` +
        `EV/SP-train one point above the threat to remove the variance.`,
    );
  }
  if (defender.hasAbility('Multiscale') && defender.curHP() === defender.maxHP()) {
    flags.push('Assumes Multiscale intact (defender at full HP) — incoming damage is halved. Chip first to break it.');
  }
  // The engine records which mechanics were actually applied on rawDesc; expose protect interactions.
  if (result.rawDesc.isProtected) {
    flags.push('Defender is Protected — damage reflects a protect-bypassing interaction (e.g. Unseen Fist / Piercing Drill).');
  }
  return flags;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function calcDamage(
  attacker: MonInput,
  defender: MonInput,
  move: MoveInput,
  field?: FieldInput,
): CalcResult {
  assertNoTera(attacker, defender);
  const gen = championsGen();
  const atk = buildMon(attacker);
  const def = buildMon(defender);
  const moveOpts: Record<string, unknown> = {
    isCrit: move.isCrit,
    hits: move.hits,
    timesUsed: move.timesUsed,
  };
  // Same override path for moves a later regulation added (see champions.ts overlay).
  if (!gen.moves.get(toID(move.name))) {
    const overrides = moveOverrides(move.name);
    if (!overrides) throw new Error(`${move.name} is not a Champions move.`);
    moveOpts.overrides = overrides;
  }
  const mv = new Move(gen, move.name, moveOpts as unknown as ConstructorParameters<typeof Move>[2]);
  const fld = new Field({
    gameType: field?.gameType ?? 'Doubles',
    weather: field?.weather,
    terrain: field?.terrain,
    isGravity: field?.isGravity,
    isTrickRoom: field?.isTrickRoom,
    attackerSide: field?.attackerSide,
    defenderSide: field?.defenderSide,
  } as unknown as ConstructorParameters<typeof Field>[0]);

  const result = calculate(gen, atk, def, mv, fld);
  const rolls = normalizeRolls(result.damage as number | number[] | number[][]);
  const maxHP = def.maxHP();
  // range() returns the true total min/max (correct for multi-hit/multi-turn damage matrices).
  const [min, max] = rolls.length ? result.range() : [0, 0];

  let koChance = '';
  try {
    koChance = result.kochance().text ?? '';
  } catch {
    /* some results (status moves) have no KO chance */
  }

  let desc = '';
  try {
    desc = result.fullDesc('');
  } catch {
    try {
      desc = result.moveDesc();
    } catch {
      /* non-fatal */
    }
  }

  return {
    rolls,
    minDamage: min,
    maxDamage: max,
    minPct: maxHP ? round1((100 * min) / maxHP) : 0,
    maxPct: maxHP ? round1((100 * max) / maxHP) : 0,
    defenderMaxHP: maxHP,
    koChance,
    desc,
    flags: collectFlags(atk, def, result),
  };
}
