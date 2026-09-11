/** Pokémon type → display color for badges/pills. Client-safe constant (no engine import). */
const TYPE_COLORS: Record<string, string> = {
  Normal: '#9fa19f',
  Fire: '#e8702a',
  Water: '#2992f0',
  Electric: '#e0b400',
  Grass: '#3da224',
  Ice: '#3dcef3',
  Fighting: '#d3425f',
  Poison: '#a13fa1',
  Ground: '#cd8136',
  Flying: '#92aade',
  Psychic: '#f65888',
  Bug: '#92a212',
  Rock: '#b0aa82',
  Ghost: '#6a5c97',
  Dragon: '#4f60e2',
  Dark: '#50413f',
  Steel: '#5f8ea0',
  Fairy: '#ee90e6',
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#6b7280';
}
