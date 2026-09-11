/**
 * Pokémon Champions Stat Point (SP) system.
 *
 * Champions replaced EVs/IVs: every Pokémon is Level 50 with IVs fixed at 31, and training is
 * distributed as Stat Points — up to 32 per stat, 66 total. `@smogon/calc` models Champions as
 * generation 0 and reuses the `evs` field to carry SP (see `engine.ts`). This module documents the
 * formula and provides budget validation + a pure stat calculation for the UI and tests.
 *
 * Authoritative formula (mirrors `@smogon/calc` `Stats.calcStatChampions`, dispatched by gen.num === 0):
 *   HP    = base + SP + 75            (unless base === 1, e.g. Shedinja)
 *   other = floor(nature × (base + SP + 20))     nature ∈ {1.1, 1.0, 0.9}
 * IVs and level are not used — Level 50 and IV 31 are baked into the constants.
 */

export type Stat = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export const STAT_ORDER: readonly Stat[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export const SP_PER_STAT_MAX = 32;
export const SP_TOTAL_MAX = 66;

export type SpSpread = Partial<Record<Stat, number>>;
export type StatSpread = Record<Stat, number>;

/** Short display names for the six stats (UI labels, paste export). */
export const STAT_LABEL: Record<Stat, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** Placeholder computed stats for a species the engine cannot resolve. */
export const ZERO_STATS: StatSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

/** Nature → [boosted stat, lowered stat]. Neutral natures omit both. Non-HP stats only. */
const NATURES: Record<string, [Stat?, Stat?]> = {
  hardy: [], lonely: ['atk', 'def'], brave: ['atk', 'spe'], adamant: ['atk', 'spa'],
  naughty: ['atk', 'spd'], bold: ['def', 'atk'], docile: [], relaxed: ['def', 'spe'],
  impish: ['def', 'spa'], lax: ['def', 'spd'], timid: ['spe', 'atk'], hasty: ['spe', 'def'],
  serious: [], jolly: ['spe', 'spa'], naive: ['spe', 'spd'], modest: ['spa', 'atk'],
  mild: ['spa', 'def'], quiet: ['spa', 'spe'], bashful: [], rash: ['spa', 'spd'],
  calm: ['spd', 'atk'], gentle: ['spd', 'def'], sassy: ['spd', 'spe'], careful: ['spd', 'spa'],
  quirky: [],
};

export function natureMultiplier(nature: string | undefined, stat: Stat): number {
  if (!nature || stat === 'hp') return 1;
  const [plus, minus] = NATURES[nature.toLowerCase()] ?? [];
  if (plus === stat && minus === stat) return 1;
  if (plus === stat) return 1.1;
  if (minus === stat) return 0.9;
  return 1;
}

/** Pure Champions stat calc. The engine (`engine.computeStats`) is authoritative; this matches it. */
export function calcChampionsStat(stat: Stat, base: number, sp: number, nature?: string): number {
  if (stat === 'hp') return base === 1 ? 1 : base + sp + 75;
  return Math.floor(natureMultiplier(nature, stat) * (base + sp + 20));
}

export function calcChampionsStats(base: StatSpread, sp: SpSpread, nature?: string): StatSpread {
  return STAT_ORDER.reduce((acc, s) => {
    acc[s] = calcChampionsStat(s, base[s], sp[s] ?? 0, nature);
    return acc;
  }, {} as StatSpread);
}

export interface SpValidation {
  ok: boolean;
  total: number;
  remaining: number;
  errors: string[];
}

/**
 * Clamp a single stat's proposed SP value so the spread stays legal: 0–32 for the stat and a
 * running total ≤ 66 across all stats. Returns the largest legal value ≤ the request.
 */
export function clampSpToBudget(sp: SpSpread, stat: Stat, value: number): number {
  const v = Math.floor(Number(value));
  if (Number.isNaN(v) || v < 0) return 0;
  const othersTotal = STAT_ORDER.reduce((sum, s) => (s === stat ? sum : sum + (sp[s] ?? 0)), 0);
  const maxForStat = Math.min(SP_PER_STAT_MAX, SP_TOTAL_MAX - othersTotal);
  return Math.max(0, Math.min(v, maxForStat));
}

/** Enforce the Champions SP budget: each stat 0–32, sum ≤ 66. */
export function validateSp(sp: SpSpread): SpValidation {
  const errors: string[] = [];
  let total = 0;
  for (const s of STAT_ORDER) {
    const v = sp[s] ?? 0;
    if (!Number.isInteger(v) || v < 0) errors.push(`${s.toUpperCase()} SP must be a non-negative integer (got ${v}).`);
    if (v > SP_PER_STAT_MAX) errors.push(`${s.toUpperCase()} SP ${v} exceeds the ${SP_PER_STAT_MAX} per-stat cap.`);
    total += v;
  }
  if (total > SP_TOTAL_MAX) errors.push(`Total SP ${total} exceeds the ${SP_TOTAL_MAX} budget.`);
  return { ok: errors.length === 0, total, remaining: SP_TOTAL_MAX - total, errors };
}
