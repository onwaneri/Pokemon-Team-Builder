/**
 * Mega Evolution as one concept: a base species holding its Mega Stone, and the Mega forme it
 * becomes on its first attack. The engine never Mega Evolves on its own (a stone only matters to it
 * for Knock Off), so anything that calcs, judges, or describes a Mega-capable Pokémon must be told
 * both forms explicitly. These helpers are that single source:
 *
 *   - `megaFormsFor(species, item)`  → { base, mega, stone } for either representation
 *     (base species + stone, or the Mega forme itself), else null.
 *   - `calcSpecies(species, item)`   → the forme to hand the engine: the Mega when the stone is held.
 *   - `formsJson` / `describeForms`  → both formes' typing, abilities, and base stats for prompts.
 *
 * Server-only (walks the dex). The client mirror is lib/megaForms.ts over the FormLists maps.
 */
import { getSpecies, isLegalSpecies, isMegaSpecies, baseSpeciesOf, megaStoneMaps } from './champions';
import type { RulesetId } from '@/lib/rulesets';

export { isMegaSpecies };

export interface MegaForms {
  base: string;
  mega: string;
  stone: string;
}

/** The Mega forme a stone evolves into (exact species name), or null for a non-stone item. */
export function megaForStone(item: string | undefined): string | null {
  if (!item) return null;
  return megaStoneMaps().megaOfStone.get(item.toLowerCase()) ?? null;
}

/** True when the item is any Mega Stone. */
export function isMegaStone(item: string | undefined): boolean {
  return megaForStone(item) !== null;
}

/** The stone a Mega forme needs, or null. */
export function stoneForMega(species: string): string | null {
  return megaStoneMaps().stoneOfMega.get(species) ?? null;
}

/**
 * Both formes of a Mega-capable Pokémon. Works from either representation: the Mega forme itself
 * (the stone is implied), or the base species holding that forme's stone. Null otherwise — a base
 * species holding someone else's stone is not Mega-capable.
 */
export function megaFormsFor(species: string, item?: string): MegaForms | null {
  if (isMegaSpecies(species)) {
    const stone = stoneForMega(species);
    return stone ? { base: baseSpeciesOf(species), mega: species, stone } : null;
  }
  const mega = megaForStone(item);
  if (mega && baseSpeciesOf(mega) === species) return { base: species, mega, stone: item! };
  return null;
}

/**
 * The forme to calc with. A base species holding its stone Mega Evolves before its first attack, so
 * every number that matters is the Mega's. Falls back to the given species when the Mega forme is
 * not legal in the ruleset.
 */
export function calcSpecies(species: string, item: string | undefined, ruleset?: RulesetId): string {
  const forms = megaFormsFor(species, item);
  if (!forms) return species;
  return ruleset && !isLegalSpecies(forms.mega, ruleset) ? species : forms.mega;
}

export interface FormInfo {
  species: string;
  types: string[];
  abilities: string[];
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}

function formInfo(species: string): FormInfo {
  const d = getSpecies(species);
  return { species, types: d?.types ?? [], abilities: d?.abilities ?? [], baseStats: d?.baseStats ?? { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } };
}

/** Structured both-formes block for JSON prompts; null when the Pokémon is not Mega-capable. */
export function formsJson(species: string, item?: string): { stone: string; base: FormInfo; mega: FormInfo; note: string } | null {
  const forms = megaFormsFor(species, item);
  if (!forms) return null;
  return {
    stone: forms.stone,
    base: formInfo(forms.base),
    mega: formInfo(forms.mega),
    note: `Holds ${forms.stone}: Mega Evolves into ${forms.mega} on its first attack. Judge it as ${forms.mega} in battle; use species "${forms.mega}" for calcs. Only one Pokémon per team Mega Evolves per battle.`,
  };
}

function fmtInfo(f: FormInfo): string {
  const b = f.baseStats;
  return `${f.species}: ${f.types.join('/') || '?'}, ${f.abilities.join('/') || '?'}, base ${b.hp}/${b.atk}/${b.def}/${b.spa}/${b.spd}/${b.spe}`;
}

/**
 * One-line both-formes note for text prompts, e.g.
 * "MEGA-CAPABLE via Charizardite X — before: Charizard: Fire/Flying, Blaze/Solar Power, base 78/84/78/109/85/100;
 *  after Mega Evolving: Charizard-Mega-X: Fire/Dragon, Tough Claws, base 78/130/111/130/85/100 (calc as "Charizard-Mega-X")".
 * Empty string when the Pokémon is not Mega-capable, so callers can append it unconditionally.
 */
export function describeForms(species: string, item?: string): string {
  const forms = megaFormsFor(species, item);
  if (!forms) return '';
  return `MEGA-CAPABLE via ${forms.stone} — before: ${fmtInfo(formInfo(forms.base))}; after Mega Evolving: ${fmtInfo(formInfo(forms.mega))} (calc as "${forms.mega}"; one Mega per team per battle)`;
}
