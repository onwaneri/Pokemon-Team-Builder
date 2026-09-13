/**
 * Client-side mirror of lib/data/megas.ts over the FormLists maps: which two formes a slot can show
 * and which item makes that possible. Pure; safe in components.
 */
import type { FormLists } from '@/lib/data/champions';

export interface MegaForms {
  base: string;
  mega: string;
  stone: string;
}

export function isMegaSpecies(name: string | undefined): boolean {
  return !!name && /-Mega(-[XYZ])?$/.test(name);
}

/**
 * Both formes for a species + item, or null when the Pokémon is not Mega-capable here. A Mega forme
 * implies its stone; a base species qualifies only while holding its own forme's stone.
 */
export function megaFormsFor(species: string, item: string | undefined, lists: FormLists): MegaForms | null {
  const stone = lists.stoneOfMega[species];
  if (stone) return { base: lists.megaBase[species] ?? species, mega: species, stone };
  const mega = item ? lists.megaOfStone[item] : undefined;
  if (mega && lists.megaBase[mega] === species) return { base: species, mega, stone: item! };
  return null;
}

/** The ability to carry across a forme switch: keep it if the target forme allows it, else its first. */
export function abilityForForme(current: string | undefined, target: string, lists: FormLists): string {
  const legal = lists.speciesAbilities[target] ?? [];
  if (current && legal.some((a) => a.toLowerCase() === current.toLowerCase())) return current;
  return legal[0] ?? current ?? '';
}
