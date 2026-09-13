/**
 * Mega Stone ↔ Mega forme mapping, derived from @pkmn/dex (`requiredItem` on every Mega forme the
 * dex knows, including the Champions "-Z" formes). Server-only: used by the team builder to keep
 * a team to one Mega and to turn "base species holding its stone" into the Mega forme the engine
 * actually calcs with.
 */
import { Dex } from '@pkmn/dex';
import { listSpecies } from './champions';
import type { RulesetId } from '@/lib/rulesets';

let stoneToMega: Map<string, string> | null = null;
let megaToStone: Map<string, string> | null = null;

function build(): void {
  stoneToMega = new Map();
  megaToStone = new Map();
  // Every forme any ruleset can use; the maps are ruleset-agnostic and callers check legality.
  const names = new Set<string>();
  for (const id of ['reg-m-b', 'reg-m-c'] as RulesetId[]) for (const s of listSpecies(id)) names.add(s);
  for (const name of names) {
    if (!/-Mega(-[XYZ])?$/.test(name)) continue;
    const s = Dex.species.get(name);
    const stone = s?.exists ? s.requiredItem : undefined;
    if (stone) { stoneToMega.set(stone.toLowerCase(), name); megaToStone.set(name, stone); }
  }
}

/** The Mega forme a stone evolves into (exact species name), or null for a non-stone item. */
export function megaForStone(item: string | undefined): string | null {
  if (!item) return null;
  if (!stoneToMega) build();
  return stoneToMega!.get(item.toLowerCase()) ?? null;
}

/** True when the item is any Mega Stone. */
export function isMegaStone(item: string | undefined): boolean {
  return megaForStone(item) !== null;
}

/** The stone a Mega forme needs, or null. */
export function stoneForMega(species: string): string | null {
  if (!megaToStone) build();
  return megaToStone!.get(species) ?? null;
}

/** A set counts as the team's Mega if it is a Mega forme or holds a Mega Stone. */
export function usesMega(set: { species: string; item?: string }): boolean {
  return /-Mega(-[XYZ])?$/.test(set.species) || isMegaStone(set.item);
}
