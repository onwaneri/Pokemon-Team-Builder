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
 * The vendored gen-0 move table is also incomplete for 84 entries (no type and/or no category);
 * `repairedMoves` refills them from @pkmn/dex so that accessors, the move pickers, and the calc all
 * see one corrected view. Without it 11 damaging moves silently score 0 damage.
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
  /** Doubles spread target (e.g. "allAdjacentFoes"), which drives the 0.75x spread modifier. */
  target?: string;
  /** Fixed hit count for multi-hit moves (Gear Grind 2, Triple Dive 3). */
  multihit?: number | number[];
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

// ─── Repairing incomplete gen-0 move entries ───────────────────────────────────

/**
 * Moves the vendored Champions table left without a type or a category, refilled from @pkmn/dex.
 *
 * `vendor/smogon-calc/data/moves.js` builds the gen-0 table as
 * `extend(true, {}, SV[name], CHAMPIONS_PATCH)`. A move that Champions rebalanced but that has no
 * entry of its own in the SV delta table therefore keeps **only** the patched base power — its
 * type, category, target and flags are dropped. The same file then skips its `category ??= 'Status'`
 * default for gen 0, so both fields stay `undefined`, and `calculate()` scores every one of the 11
 * affected damaging moves (Astral Barrage, Bolt Beak, Blood Moon, Triple Dive, …) as **0 damage**
 * against every target. 72 further entries lose only their category; they are all status moves, so
 * no damage was wrong, but they rendered with no category badge in the move pickers.
 *
 * We refill the missing fields from @pkmn/dex and keep the gen-0 base power, which is the
 * Champions-specific value and must win over the mainline one (Astral Barrage is 110 here, 120 in
 * Gen 9). Everything downstream — `getMove`, `moveInfo`, and the engine via `moveOverrides` — reads
 * through this layer, so the repair happens once.
 */
const repairedMoves: Record<string, RawMove> = {};
for (const [name, raw] of Object.entries(moveMap)) {
  if (raw.type && raw.category) continue;
  const d = Dex.moves.get(name);
  if (!d?.exists) {
    console.warn(`[champions] gen-0 move ${name} is missing type/category and @pkmn/dex cannot repair it.`);
    continue;
  }
  repairedMoves[name] = {
    ...raw,
    // Champions base power is authoritative; only absent fields are taken from the mainline dex.
    // `?? ` not `|| ` — a genuine 0 (status moves, and variable-power moves like Low Kick) must
    // survive, but Metal Claw's entry is literally `{isSlicing: true}` with no bp at all, which
    // would otherwise make it a 0-damage move.
    bp: raw.bp ?? d.basePower,
    type: raw.type || d.type,
    category: raw.category || (d.category as RawMove['category']),
    ...(raw.makesContact || d.flags?.contact ? { makesContact: true } : {}),
    ...(raw.priority || d.priority ? { priority: raw.priority || d.priority } : {}),
    ...(raw.target || d.target ? { target: raw.target || d.target } : {}),
    ...(raw.multihit || d.multihit ? { multihit: raw.multihit ?? (d.multihit as RawMove['multihit']) } : {}),
  };
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
  // Repaired entries shadow the raw gen-0 ones (see `repairedMoves`).
  const raw = repairedMoves[name] ?? moveMap[name] ?? overlayMoves[name];
  if (!raw) return null;
  return { name, basePower: raw.bp, type: raw.type, category: raw.category, makesContact: !!raw.makesContact, priority: raw.priority ?? 0, overlay: !(name in moveMap) };
}
export function isLegalMove(name: string, reg: RulesetId = DEFAULT_RULESET): boolean {
  return movePool(reg).has(name);
}
function overridePayload(name: string, raw: RawMove): Record<string, unknown> {
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
    ...(raw.target ? { target: raw.target } : {}),
    ...(raw.multihit ? { multihit: raw.multihit } : {}),
  };
}

/**
 * Engine override payload for a move the gen-0 table cannot be used for as-is; null for entries
 * that are already complete. Two cases: a move a later regulation added (not in the gen-0 table at
 * all), and a gen-0 entry the vendored build left without a type or category (see `repairedMoves`
 * — those DO resolve through `gen.moves.get`, so callers must ask here rather than testing
 * presence). The calc deep-merges the payload over its own lookup, so a partial entry is completed
 * rather than replaced.
 */
export function moveOverrides(name: string): Record<string, unknown> | null {
  const repaired = repairedMoves[name];
  if (repaired) return overridePayload(name, repaired);
  if (moveMap[name]) return null;
  const raw = overlayMoves[name];
  if (!raw) return null;
  return overridePayload(name, raw);
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
  /** Pickable species: base formes only. A Mega is reached by attaching its stone, never picked. */
  species: string[];
  /** Every legal species including Mega formes (opponent pickers, lookups). */
  speciesAll: string[];
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
  moveInfo: Record<string, { type: string; category: 'Physical' | 'Special' | 'Status' | ''; bp: number; desc: string }>;
  /** item name → one-line description. */
  itemDesc: Record<string, string>;
  /** Mega Stone → the Mega forme it evolves into (only formes legal in this ruleset). */
  megaOfStone: Record<string, string>;
  /** Mega forme → its Mega Stone. */
  stoneOfMega: Record<string, string>;
  /** Mega forme → the base species that holds the stone. */
  megaBase: Record<string, string>;
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

/** True for any Mega forme name ("Dragonite-Mega", "Charizard-Mega-Y", "Absol-Mega-Z"). */
export function isMegaSpecies(name: string | undefined): boolean {
  return !!name && /-Mega(-[XYZ])?$/.test(name);
}

/** The species that Mega Evolves into `mega` (the table's base, else the name minus its suffix). */
export function baseSpeciesOf(mega: string): string {
  return MEGA_STONES[mega]?.base ?? getSpecies(mega)?.baseSpecies ?? mega.replace(/-Mega(-[XYZ])?$/, '');
}

/**
 * Mega forme → base species + Mega Stone. Hardcoded on purpose: this is a short, closed list
 * (all 48 Gen 6/7 Megas plus the 49 Legends: Z-A / Mega Dimension ones) and nothing downstream
 * should depend on a dex package agreeing with it. Species names are Showdown's hyphenated ones;
 * stone names match Showdown's items.ts and Bulbapedia's Mega Stone list. Formes outside the
 * Champions pool are harmless here (formLists only exposes pool species). Rayquaza-Mega needs no
 * stone and is omitted. Several stones are shared: Meowsticite (M/F), Magearnite, Tatsugirinite —
 * the stone→forme map keeps the first (plain) forme for those.
 */
export const MEGA_STONES: Record<string, { base: string; stone: string }> = {
  'Abomasnow-Mega': { base: 'Abomasnow', stone: 'Abomasite' },
  'Absol-Mega': { base: 'Absol', stone: 'Absolite' },
  'Absol-Mega-Z': { base: 'Absol', stone: 'Absolite Z' },
  'Aerodactyl-Mega': { base: 'Aerodactyl', stone: 'Aerodactylite' },
  'Aggron-Mega': { base: 'Aggron', stone: 'Aggronite' },
  'Alakazam-Mega': { base: 'Alakazam', stone: 'Alakazite' },
  'Altaria-Mega': { base: 'Altaria', stone: 'Altarianite' },
  'Ampharos-Mega': { base: 'Ampharos', stone: 'Ampharosite' },
  'Audino-Mega': { base: 'Audino', stone: 'Audinite' },
  'Banette-Mega': { base: 'Banette', stone: 'Banettite' },
  'Barbaracle-Mega': { base: 'Barbaracle', stone: 'Barbaracite' },
  'Baxcalibur-Mega': { base: 'Baxcalibur', stone: 'Baxcalibrite' },
  'Beedrill-Mega': { base: 'Beedrill', stone: 'Beedrillite' },
  'Blastoise-Mega': { base: 'Blastoise', stone: 'Blastoisinite' },
  'Blaziken-Mega': { base: 'Blaziken', stone: 'Blazikenite' },
  'Camerupt-Mega': { base: 'Camerupt', stone: 'Cameruptite' },
  'Chandelure-Mega': { base: 'Chandelure', stone: 'Chandelurite' },
  'Charizard-Mega-X': { base: 'Charizard', stone: 'Charizardite X' },
  'Charizard-Mega-Y': { base: 'Charizard', stone: 'Charizardite Y' },
  'Chesnaught-Mega': { base: 'Chesnaught', stone: 'Chesnaughtite' },
  'Chimecho-Mega': { base: 'Chimecho', stone: 'Chimechite' },
  'Clefable-Mega': { base: 'Clefable', stone: 'Clefablite' },
  'Crabominable-Mega': { base: 'Crabominable', stone: 'Crabominite' },
  'Darkrai-Mega': { base: 'Darkrai', stone: 'Darkranite' },
  'Delphox-Mega': { base: 'Delphox', stone: 'Delphoxite' },
  'Diancie-Mega': { base: 'Diancie', stone: 'Diancite' },
  'Dragalge-Mega': { base: 'Dragalge', stone: 'Dragalgite' },
  'Dragonite-Mega': { base: 'Dragonite', stone: 'Dragoninite' },
  'Drampa-Mega': { base: 'Drampa', stone: 'Drampanite' },
  'Eelektross-Mega': { base: 'Eelektross', stone: 'Eelektrossite' },
  'Emboar-Mega': { base: 'Emboar', stone: 'Emboarite' },
  'Excadrill-Mega': { base: 'Excadrill', stone: 'Excadrite' },
  'Falinks-Mega': { base: 'Falinks', stone: 'Falinksite' },
  'Feraligatr-Mega': { base: 'Feraligatr', stone: 'Feraligite' },
  'Floette-Mega': { base: 'Floette-Eternal', stone: 'Floettite' },
  'Froslass-Mega': { base: 'Froslass', stone: 'Froslassite' },
  'Gallade-Mega': { base: 'Gallade', stone: 'Galladite' },
  'Garchomp-Mega': { base: 'Garchomp', stone: 'Garchompite' },
  'Garchomp-Mega-Z': { base: 'Garchomp', stone: 'Garchompite Z' },
  'Gardevoir-Mega': { base: 'Gardevoir', stone: 'Gardevoirite' },
  'Gengar-Mega': { base: 'Gengar', stone: 'Gengarite' },
  'Glalie-Mega': { base: 'Glalie', stone: 'Glalitite' },
  'Glimmora-Mega': { base: 'Glimmora', stone: 'Glimmoranite' },
  'Golisopod-Mega': { base: 'Golisopod', stone: 'Golisopite' },
  'Golurk-Mega': { base: 'Golurk', stone: 'Golurkite' },
  'Greninja-Mega': { base: 'Greninja', stone: 'Greninjite' },
  'Gyarados-Mega': { base: 'Gyarados', stone: 'Gyaradosite' },
  'Hawlucha-Mega': { base: 'Hawlucha', stone: 'Hawluchanite' },
  'Heatran-Mega': { base: 'Heatran', stone: 'Heatranite' },
  'Heracross-Mega': { base: 'Heracross', stone: 'Heracronite' },
  'Houndoom-Mega': { base: 'Houndoom', stone: 'Houndoominite' },
  'Kangaskhan-Mega': { base: 'Kangaskhan', stone: 'Kangaskhanite' },
  'Latias-Mega': { base: 'Latias', stone: 'Latiasite' },
  'Latios-Mega': { base: 'Latios', stone: 'Latiosite' },
  'Lopunny-Mega': { base: 'Lopunny', stone: 'Lopunnite' },
  'Lucario-Mega': { base: 'Lucario', stone: 'Lucarionite' },
  'Lucario-Mega-Z': { base: 'Lucario', stone: 'Lucarionite Z' },
  'Magearna-Mega': { base: 'Magearna', stone: 'Magearnite' },
  'Magearna-Original-Mega': { base: 'Magearna-Original', stone: 'Magearnite' },
  'Malamar-Mega': { base: 'Malamar', stone: 'Malamarite' },
  'Manectric-Mega': { base: 'Manectric', stone: 'Manectite' },
  'Mawile-Mega': { base: 'Mawile', stone: 'Mawilite' },
  'Medicham-Mega': { base: 'Medicham', stone: 'Medichamite' },
  'Meganium-Mega': { base: 'Meganium', stone: 'Meganiumite' },
  'Meowstic-F-Mega': { base: 'Meowstic-F', stone: 'Meowsticite' },
  'Meowstic-M-Mega': { base: 'Meowstic', stone: 'Meowsticite' },
  'Metagross-Mega': { base: 'Metagross', stone: 'Metagrossite' },
  'Mewtwo-Mega-X': { base: 'Mewtwo', stone: 'Mewtwonite X' },
  'Mewtwo-Mega-Y': { base: 'Mewtwo', stone: 'Mewtwonite Y' },
  'Pidgeot-Mega': { base: 'Pidgeot', stone: 'Pidgeotite' },
  'Pinsir-Mega': { base: 'Pinsir', stone: 'Pinsirite' },
  'Pyroar-Mega': { base: 'Pyroar', stone: 'Pyroarite' },
  'Raichu-Mega-X': { base: 'Raichu', stone: 'Raichunite X' },
  'Raichu-Mega-Y': { base: 'Raichu', stone: 'Raichunite Y' },
  'Sableye-Mega': { base: 'Sableye', stone: 'Sablenite' },
  'Salamence-Mega': { base: 'Salamence', stone: 'Salamencite' },
  'Sceptile-Mega': { base: 'Sceptile', stone: 'Sceptilite' },
  'Scizor-Mega': { base: 'Scizor', stone: 'Scizorite' },
  'Scolipede-Mega': { base: 'Scolipede', stone: 'Scolipite' },
  'Scovillain-Mega': { base: 'Scovillain', stone: 'Scovillainite' },
  'Scrafty-Mega': { base: 'Scrafty', stone: 'Scraftinite' },
  'Sharpedo-Mega': { base: 'Sharpedo', stone: 'Sharpedonite' },
  'Skarmory-Mega': { base: 'Skarmory', stone: 'Skarmorite' },
  'Slowbro-Mega': { base: 'Slowbro', stone: 'Slowbronite' },
  'Staraptor-Mega': { base: 'Staraptor', stone: 'Staraptite' },
  'Starmie-Mega': { base: 'Starmie', stone: 'Starminite' },
  'Steelix-Mega': { base: 'Steelix', stone: 'Steelixite' },
  'Swampert-Mega': { base: 'Swampert', stone: 'Swampertite' },
  'Tatsugiri-Curly-Mega': { base: 'Tatsugiri', stone: 'Tatsugirinite' },
  'Tatsugiri-Droopy-Mega': { base: 'Tatsugiri-Droopy', stone: 'Tatsugirinite' },
  'Tatsugiri-Stretchy-Mega': { base: 'Tatsugiri-Stretchy', stone: 'Tatsugirinite' },
  'Tyranitar-Mega': { base: 'Tyranitar', stone: 'Tyranitarite' },
  'Venusaur-Mega': { base: 'Venusaur', stone: 'Venusaurite' },
  'Victreebel-Mega': { base: 'Victreebel', stone: 'Victreebelite' },
  'Zeraora-Mega': { base: 'Zeraora', stone: 'Zeraorite' },
  'Zygarde-Mega': { base: 'Zygarde-Complete', stone: 'Zygardite' },
};

/** Stone ↔ Mega forme lookups over MEGA_STONES (lowercased stone keys). Built once. */
let stoneMaps: { megaOfStone: Map<string, string>; stoneOfMega: Map<string, string> } | null = null;
export function megaStoneMaps(): { megaOfStone: Map<string, string>; stoneOfMega: Map<string, string> } {
  if (stoneMaps) return stoneMaps;
  const megaOfStone = new Map<string, string>();
  const stoneOfMega = new Map<string, string>();
  for (const [mega, { stone }] of Object.entries(MEGA_STONES)) {
    megaOfStone.set(stone.toLowerCase(), mega);
    stoneOfMega.set(mega, stone);
  }
  stoneMaps = { megaOfStone, stoneOfMega };
  return stoneMaps;
}

/** Everything the calc form's dropdowns need for one ruleset, in one server-side call. */
export function formLists(reg: RulesetId = DEFAULT_RULESET): FormLists {
  const species = listSpecies(reg); // full list; every per-species map below is keyed on it
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
    // `category` is '' only if the gen-0 entry was incomplete AND @pkmn/dex could not repair it.
    // It used to default to 'Status', which mislabelled every damaging move in that state.
    moveInfo[m] = { type: mv?.type ?? '', category: mv?.category ?? '', bp: mv?.basePower ?? 0, desc: dexText('moves', m) };
  }
  const items = listItems(reg);
  const abilities = listAbilities();

  const maps = megaStoneMaps();
  const megaOfStone: Record<string, string> = {};
  const stoneOfMega: Record<string, string> = {};
  const megaBase: Record<string, string> = {};
  for (const s of species) {
    const stone = maps.stoneOfMega.get(s);
    if (!stone) continue;
    const stoneName = items.find((i) => i.toLowerCase() === stone.toLowerCase()) ?? stone;
    megaOfStone[stoneName] = s;
    stoneOfMega[s] = stoneName;
    megaBase[s] = baseSpeciesOf(s);
  }

  return {
    regulation: reg,
    species: species.filter((s) => !isMegaSpecies(s)),
    speciesAll: species,
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
    megaOfStone,
    stoneOfMega,
    megaBase,
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
