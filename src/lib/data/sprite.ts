/**
 * Pokémon sprite URLs via @pkmn/img (Pokémon Showdown sprite CDN). Client-safe.
 *
 * Canonical species resolve to a static front sprite. Champions-invented Megas/formes that aren't
 * in the standard dex may resolve to a 404 — callers should render a text fallback on <img> error.
 */
import { Sprites } from '@pkmn/img';

export function spriteUrl(species: string): string {
  if (!species) return '';
  try {
    return Sprites.getDexPokemon(species, { gen: 'gen5' }).url;
  } catch {
    return '';
  }
}
