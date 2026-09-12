/**
 * Champions (gen 0) data accessors over the vendored `@smogon/calc` dataset, scoped by ruleset.
 *
 * The package ships the Reg M-B Champions dex as generation 0 — that is the substrate. Rulesets
 * (src/lib/rulesets) are deltas applied on top: added/banned species, items, and moves. Added
 * species and moves are grafted from @pkmn/dex into the same compact shape so every accessor, the
 * legality gate, and the calc engine (via overrides — see engine.ts) treat them exactly like native
 * entries. Legality is always asked per ruleset: a Reg M-C addition is "in the dex" but not legal
 * in Reg M-B.
 *
 * Server-only (pulls in the 2.3M calc dataset); never import into client code.
 */
import { SPECIES, MOVES, ITEMS, ABILITIES, NATURES } from '@smogon/calc';
import { Dex } from '@pkmn/dex';
import { ZERO_STATS, type Stat, type StatSpread } from '../calc/sp';
import { RULESETS, RULESET_IDS, DEFAULT_RULESET, getRuleset, type RulesetId } from '@/lib/rulesets';

const GEN = 0;

interface RawSpecies {
  types: string[];
  bs: { hp: number; at: number; df: number; sa: number; sd: number; sp: number };
  weightkg?: number;
  abilities?: Record<string, string>;
  otherFormes?: string[];
  baseSpecies?: string;
}
interface RawMove {
  bp: number;
  type: string;
  category: 'Physical' | 'Special' | 'Status';
  makesContact?: boolean;
  priority?: number;
  secondaries?: boolean;
}

// Species & moves are stored fully at gen 0 (the Champions dex). Items & abilities are stored as
// per-gen *additions* — inherited entries (e.g. Choice Band) live in later-gen slots — so they must be
// merged across all gens to reconstruct the full pool the engine actually accepts.
const speciesMap = (SPECIES as unknown as Record<string, RawSpecies>[])[GEN];
const moveMap = (MOVES as unknown as Record<string, RawMove>[])[GEN];

function mergeNamesAcrossGens(perGen: unknown): string[] {
  const set = new Set<string>();
  for (const gen of perGen as Record<string, string>[]) {
    if (gen) for (const name of Object.values(gen)) if (name) set.add(name);
  }
  return [...set];
}
// Gen 0 is the curated Champions item list — it explicitly includes only format-legal items
// (Mega Stones, specific berries, specific held items). Items absent from gen 0 (e.g. Choice Band,
// Assault Vest) are banned or unavailable in Reg M-B. Rulesets add to (or remove from) it.
const gen0Items = (ITEMS as unknown as Record<string, string>[])[0] ?? {};
const baseItemSet = new Set(Object.values(gen0Items).filter((n): n is string => !!n));
const abilityNames = mergeNamesAcrossGens(ABILITIES);
const natureNames = Object.keys(NATURES as unknown as Record<string, unknown>);

// ─── Ruleset overlays (grafted from @pkmn/dex) ─────────────────────────────────

/** Species added by any ruleset, in the gen-0 compact shape. Built once at module load. */
const overlaySpecies: Record<string, RawSpecies> = {};
/** Moves added by any ruleset, in the gen-0 compact shape. */
const overlayMoves: Record<string, RawMove> = {};

for (const id of RULESET_IDS) {
  for (const name of RULESETS[id].addedSpecies) {
    if (speciesMap[name] || overlaySpecies[name]) continue;
    const s = Dex.species.get(name);
    if (!s?.exists) {
      console.warn(`[champions] ruleset ${id} lists ${name}, but @pkmn/dex does not know it — skipped.`);
      continue;
    }
    const abilities = Object.values(s.abilities ?? {}) as string[];
    const megaFormes = (s.otherFormes ?? []).filter((f) => /-Mega(-[XYZ])?$/.test(f));
    overlaySpecies[s.name] = {
      types: [...s.types],
      bs: { hp: s.baseStats.hp, at: s.baseStats.atk, df: s.baseStats.def, sa: s.baseStats.spa, sd: s.baseStats.spd, sp: s.baseStats.spe },
      weightkg: s.weightkg,
      abilities: Object.fromEntries(abilities.map((a, i) => [String(i), a])),
      ...(megaFormes.length ? { otherFormes: megaFormes } : {}),
      ...(s.baseSpecies && s.baseSpecies !== s.name ? { baseSpecies: s.baseSpecies } : {}),
    };
  }
  for (const name of RULESETS[id].addedMoves) {
    if (moveMap[name] || overlayMoves[name]) continue;
    const m = Dex.moves.get(name);
    if (!m?.exists) {
      console.warn(`[champions] ruleset ${id} lists move ${name}, but @pkmn/dex does not know it — skipped.`);
      continue;
    }
    overlayMoves[m.name] = {
      bp: m.basePower,
      type: m.type,
      category: m.category,
      ...(m.flags.contact ? { makesContact: true } : {}),
      ...(m.priority ? { priority: m.priority } : {}),
      ...(m.secondaries?.length ? { secondaries: true } : {}),
    };
  }
}

// ─── Applying a ruleset delta to the base pools ────────────────────────────────
// Each pool is base ∪ added − banned, memoized per ruleset. This is the only place the delta
// semantics live; every accessor below asks these.

const speciesPoolCache = new Map<RulesetId, Set<string>>();
const movePoolCache = new Map<RulesetId, Set<string>>();
const itemPoolCache = new Map<RulesetId, Set<string>>();

function speciesPool(reg: RulesetId): Set<string> {
  let pool = speciesPoolCache.get(reg);
  if (!pool) {
    const r = RULESETS[reg];
    pool = new Set([...Object.keys(speciesMap), ...r.addedSpecies.filter((n) => n in overlaySpecies || n in speciesMap)]);
    for (const b of r.bannedSpecies) pool.delete(b);
    speciesPoolCache.set(reg, pool);
  }
  return pool;
}
function movePool(reg: RulesetId): Set<string> {
  let pool = movePoolCache.get(reg);
  if (!pool) {
    const r = RULESETS[reg];
    pool = new Set([...Object.keys(moveMap), ...r.addedMoves.filter((n) => n in overlayMoves || n in moveMap)]);
    pool.delete('(No Move)');
    pool.delete('Struggle');
    for (const b of r.bannedMoves) pool.delete(b);
    movePoolCache.set(reg, pool);
  }
  return pool;
}
function itemPool(reg: RulesetId): Set<string> {
  let pool = itemPoolCache.get(reg);
  if (!pool) {
    const r = RULESETS[reg];
    pool = new Set([...baseItemSet, ...r.addedItems]);
    for (const b of r.bannedItems) pool.delete(b);
    itemPoolCache.set(reg, pool);
  }
  return pool;
}

export interface ChampSpecies {
  name: string;
  types: string[];
  baseStats: Record<Stat, number>;
  weightKg: number;
  abilities: string[];
  isMega: boolean;
  baseSpecies?: string;
  megaFormes: string[];
  /** True when the data was grafted from @pkmn/dex rather than shipped in the gen-0 dex. */
  overlay: boolean;
}

export interface ChampMove {
  name: string;
  basePower: number;
  type: string;
  category: 'Physical' | 'Special' | 'Status';
  makesContact: boolean;
  priority: number;
  overlay: boolean;
}

function normalizeSpecies(name: string, raw: RawSpecies, overlay: boolean): ChampSpecies {
  return {
    name,
    types: raw.types,
    baseStats: { hp: raw.bs.hp, atk: raw.bs.at, def: raw.bs.df, spa: raw.bs.sa, spd: raw.bs.sd, spe: raw.bs.sp },
    weightKg: raw.weightkg ?? 0,
    abilities: raw.abilities ? Object.values(raw.abilities) : [],
    isMega: /-Mega(-[XYZ])?$/.test(name),
    baseSpecies: raw.baseSpecies,
    megaFormes: (raw.otherFormes ?? []).filter((f) => /-Mega(-[XYZ])?$/.test(f)),
    overlay,
  };
}

// ---- Species ----
export function listSpecies(reg: RulesetId = DEFAULT_RULESET): string[] {
  return [...speciesPool(reg)].sort();
}
/** Species data — ruleset-agnostic (the engine needs overlay data even when checking legality elsewhere). */
export function getSpecies(name: string): ChampSpecies | null {
  const raw = speciesMap[name];
  if (raw) return normalizeSpecies(name, raw, false);
  const over = overlaySpecies[name];
  return over ? normalizeSpecies(name, over, true) : null;
}
export function isLegalSpecies(name: string, reg: RulesetId = DEFAULT_RULESET): boolean {
  return speciesPool(reg).has(name);
}
/** Default ability for a species (slot 0), for prefilling forms/imports. */
export function defaultAbility(species: string): string | undefined {
  return getSpecies(species)?.abilities[0];
}

/**
 * Engine override payload for a species the gen-0 dex lacks (a ruleset overlay entry), in the
 * shape `@smogon/calc`'s Pokemon constructor merges over its own species lookup. Null for native
 * species so callers can pass it straight through as `overrides`.
 */
export function speciesOverrides(name: string): Record<string, unknown> | null {
  if (speciesMap[name]) return null;
  const raw = overlaySpecies[name];
  if (!raw) return null;
  return {
    kind: 'Species',
    id: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    name,
    types: raw.types,
    baseStats: { hp: raw.bs.hp, atk: raw.bs.at, def: raw.bs.df, spa: raw.bs.sa, spd: raw.bs.sd, spe: raw.bs.sp },
    weightkg: raw.weightkg ?? 0,
    abilities: raw.abilities,
    nfe: false,
    ...(raw.baseSpecies ? { baseSpecies: raw.baseSpecies } : {}),
    ...(raw.otherFormes ? { otherFormes: raw.otherFormes } : {}),
  };
}

// ---- Moves ----
export function listMoves(reg: RulesetId = DEFAULT_RULESET): string[] {
  return [...movePool(reg)].sort();
}
export function getMove(name: string): ChampMove | null {
  const raw = moveMap[name] ?? overlayMoves[name];
  if (!raw) return null;
  return { name, basePower: raw.bp, type: raw.type, category: raw.category, makesContact: !!raw.makesContact, priority: raw.priority ?? 0, overlay: !(name in moveMap) };
}
export function isLegalMove(name: string, reg: RulesetId = DEFAULT_RULESET): boolean {
  return movePool(reg).has(name);
}
/** Engine override payload for a move the gen-0 table lacks; null for native moves. */
export function moveOverrides(name: string): Record<string, unknown> | null {
  if (moveMap[name]) return null;
  const raw = overlayMoves[name];
  if (!raw) return null;
  return {
    kind: 'Move',
    id: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    name,
    basePower: raw.bp,
    type: raw.type,
    category: raw.category,
    flags: raw.makesContact ? { contact: 1 } : {},
    ...(raw.priority ? { priority: raw.priority } : {}),
    ...(raw.secondaries ? { secondaries: true } : {}),
  };
}

// ---- Items / Abilities / Natures ----
export function listItems(reg: RulesetId = DEFAULT_RULESET): string[] {
  return [...itemPool(reg)].sort();
}
export function isLegalItem(name: string, reg: RulesetId = DEFAULT_RULESET): boolean {
  return itemPool(reg).has(name);
}
export function listAbilities(): string[] {
  return [...abilityNames].sort();
}
export function isLegalAbility(name: string): boolean {
  return abilityNames.includes(name);
}
export function listNatures(): string[] {
  return [...natureNames].sort();
}

export interface FormLists {
  /** Which ruleset these lists describe. */
  regulation: RulesetId;
  species: string[];
  moves: string[];
  items: string[];
  abilities: string[];
  natures: string[];
  /** species name → its legal abilities, so the ability dropdown is filtered per Pokémon. */
  speciesAbilities: Record<string, string[]>;
  /** species name → its base stats, for live stat recomputation in the team editor. */
  speciesStats: Record<string, StatSpread>;
  /** species name → its types, for type-color pills in the editor. */
  speciesTypes: Record<string, string[]>;
  /** species name → whether it's a Mega forme, for the Mega badge. */
  speciesIsMega: Record<string, boolean>;
  /** move name → type, category, base power, and a one-line description, for the move pickers. */
  moveInfo: Record<string, { type: string; category: 'Physical' | 'Special' | 'Status'; bp: number; desc: string }>;
  /** item name → one-line description. */
  itemDesc: Record<string, string>;
  /** ability name → one-line description. */
  abilityDesc: Record<string, string>;
}

/**
 * One-line effect text for a move / item / ability, from @pkmn/dex. This is MAINLINE (Gen 9)
 * wording: Champions tweaks a handful of effects (see vendor/smogon-calc/mechanics/champions.js),
 * so treat it as a reminder of what the thing does, not as a rules citation. Empty when the dex
 * has never heard of the name (Champions-only content).
 */
const descCache = new Map<string, string>();
function dexText(kind: 'moves' | 'items' | 'abilities', name: string): string {
  const key = `${kind}:${name}`;
  const hit = descCache.get(key);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    const e = Dex[kind].get(name) as { exists?: boolean; shortDesc?: string; desc?: string };
    if (e?.exists) text = e.shortDesc || e.desc || '';
  } catch {
    /* unknown to @pkmn/dex */
  }
  descCache.set(key, text);
  return text;
}
/**
 * Legal abilities for a species. @smogon/calc only stores the slot-0 ability per species (so Incineroar
 * would lose Intimidate), so we merge it with @pkmn/dex's full set (slot 0/1/hidden). Megas aren't in
 * @pkmn/dex's older data, so they keep just their fixed Champions ability.
 */
export function legalAbilities(name: string): string[] {
  const champ = getSpecies(name)?.abilities ?? [];
  let dex: string[] = [];
  try {
    const s = Dex.species.get(name);
    if (s?.exists && s.abilities) dex = Object.values(s.abilities) as string[];
  } catch {
    /* mega / unknown to @pkmn/dex */
  }
  return [...new Set([...champ, ...dex])];
}

/** Everything the calc form's dropdowns need for one ruleset, in one server-side call. */
export function formLists(reg: RulesetId = DEFAULT_RULESET): FormLists {
  const species = listSpecies(reg);
  const speciesAbilities = Object.fromEntries(species.map((s) => [s, legalAbilities(s)]));

  const speciesStats: Record<string, StatSpread> = {};
  const speciesTypes: Record<string, string[]> = {};
  const speciesIsMega: Record<string, boolean> = {};
  for (const s of species) {
    const data = getSpecies(s);
    speciesStats[s] = data?.baseStats ?? ZERO_STATS;
    speciesTypes[s] = data?.types ?? [];
    speciesIsMega[s] = data?.isMega ?? false;
  }

  const moves = listMoves(reg);
  const moveInfo: FormLists['moveInfo'] = {};
  for (const m of moves) {
    const mv = getMove(m);
    moveInfo[m] = { type: mv?.type ?? '', category: mv?.category ?? 'Status', bp: mv?.basePower ?? 0, desc: dexText('moves', m) };
  }
  const items = listItems(reg);
  const abilities = listAbilities();

  return {
    regulation: reg,
    species,
    moves,
    items,
    abilities,
    natures: listNatures(),
    speciesAbilities,
    speciesStats,
    speciesTypes,
    speciesIsMega,
    moveInfo,
    itemDesc: Object.fromEntries(items.map((i) => [i, dexText('items', i)])),
    abilityDesc: Object.fromEntries(abilities.map((a) => [a, dexText('abilities', a)])),
  };
}

export interface LegalityIssue {
  field: 'species' | 'move' | 'item' | 'ability';
  value: string;
  message: string;
}
/** Validate a set against a ruleset's legal pool (used by import, the calc form, and every AI proposal). */
export function validateLegality(
  set: { species?: string; item?: string; ability?: string; moves?: string[] },
  reg: RulesetId = DEFAULT_RULESET,
): LegalityIssue[] {
  const short = getRuleset(reg).short;
  const issues: LegalityIssue[] = [];
  if (set.species && !isLegalSpecies(set.species, reg)) {
    const known = getSpecies(set.species) !== null;
    issues.push({
      field: 'species',
      value: set.species,
      message: known ? `${set.species} is not usable in ${short}.` : `${set.species} is not in the Champions dex.`,
    });
  }
  if (set.item && !isLegalItem(set.item, reg))
    issues.push({ field: 'item', value: set.item, message: `${set.item} is not a legal ${short} item.` });
  if (set.ability && !isLegalAbility(set.ability))
    issues.push({ field: 'ability', value: set.ability, message: `${set.ability} is not a legal Champions ability.` });
  for (const m of set.moves ?? []) {
    if (m && !isLegalMove(m, reg)) issues.push({ field: 'move', value: m, message: `${m} is not a legal ${short} move.` });
  }
  return issues;
}
