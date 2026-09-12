/**
 * Instant team-name suggestions, computed locally from the composition (no network, no model).
 *
 * Reads the signals VGC players actually name teams by: the weather/terrain/Trick Room mode, the
 * Mega, and the headline core. Returns a few distinct candidates, best first, so the save dialog
 * can prefill one and offer the rest as one-click chips.
 */
import type { TeamMon } from '@/lib/benchmarks/types';

type Slot = TeamMon | null;

const MODE_BY_ABILITY: Record<string, string> = {
  Drizzle: 'Rain',
  Drought: 'Sun',
  'Sand Stream': 'Sand',
  'Snow Warning': 'Snow',
  'Grassy Surge': 'Grassy Terrain',
  'Psychic Surge': 'Psychic Terrain',
  'Electric Surge': 'Electric Terrain',
  'Misty Surge': 'Misty Terrain',
};
const MODE_BY_MOVE: Record<string, string> = {
  'Trick Room': 'Trick Room',
  'Rain Dance': 'Rain',
  'Sunny Day': 'Sun',
  Sandstorm: 'Sand',
  Snowscape: 'Snow',
  Tailwind: 'Tailwind',
};
const SUPPORT_MOVES = new Set(['Fake Out', 'Follow Me', 'Rage Powder', 'Helping Hand', 'Tailwind', 'Trick Room', 'Icy Wind', 'Wide Guard', 'Spore']);

const STYLE_FALLBACKS = ['Balance', 'Goodstuffs', 'Offense'];

/** "Charizard-Mega-Y" → "Charizard-Y"; "Dragonite-Mega" → "Dragonite"; "Indeedee-F" stays. */
function shortName(species: string): string {
  return species.replace(/-Mega(-[XYZ])?$/, (_, suffix?: string) => suffix ?? '');
}

function fmtMega(species: string): string {
  const m = /^(.+?)-Mega(?:-([XYZ]))?$/.exec(species);
  if (!m) return shortName(species);
  return `Mega ${m[1]}${m[2] ? ` ${m[2]}` : ''}`;
}

const WEATHER = new Set(['Rain', 'Sun', 'Sand', 'Snow']);

function detectModes(mons: TeamMon[]): string[] {
  const modes: string[] = [];
  const push = (m: string) => { if (!modes.includes(m)) modes.push(m); };
  // Priority mirrors how players name teams: Trick Room defines the team, then weather, then
  // terrain, then Tailwind (a rain team with a Tailwind setter is still "Rain").
  if (mons.some((m) => m.moves.includes('Trick Room'))) push('Trick Room');
  for (const mon of mons) if (mon.ability && WEATHER.has(MODE_BY_ABILITY[mon.ability] ?? '')) push(MODE_BY_ABILITY[mon.ability!]);
  for (const mon of mons) for (const mv of mon.moves) if (mv && WEATHER.has(MODE_BY_MOVE[mv] ?? '')) push(MODE_BY_MOVE[mv]);
  for (const mon of mons) if (mon.ability && MODE_BY_ABILITY[mon.ability]) push(MODE_BY_ABILITY[mon.ability]);
  for (const mon of mons) if (mon.moves.includes('Tailwind')) push('Tailwind');
  return modes;
}

/** Who sets the mode: the ability holder, else the first mon carrying the move. */
function modeSetter(mons: TeamMon[], mode: string): TeamMon | undefined {
  const byAbility = mons.find((m) => m.ability && MODE_BY_ABILITY[m.ability] === mode);
  if (byAbility) return byAbility;
  return mons.find((m) => m.moves.some((mv) => MODE_BY_MOVE[mv] === mode));
}

/** Headline attackers: prefer mons that are not pure support, keep slot order. */
function headliners(mons: TeamMon[]): TeamMon[] {
  const attackers = mons.filter((m) => m.moves.filter((mv) => mv && SUPPORT_MOVES.has(mv)).length < 2);
  return (attackers.length >= 2 ? attackers : mons).slice(0, 2);
}

export function suggestTeamNames(team: Slot[], count = 3): string[] {
  const mons = team.filter((m): m is TeamMon => m !== null && !!m.species);
  const out: string[] = [];
  const add = (name: string | null | undefined) => {
    const n = (name ?? '').replace(/\s+/g, ' ').trim();
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  if (!mons.length) return ['Untitled Team'];

  const modes = detectModes(mons);
  const mega = mons.find((m) => /-Mega(-[XYZ])?$/.test(m.species));
  const [a, b] = headliners(mons);
  const primary = modes[0];

  // 1. Mode + its setter, e.g. "Torkoal Sun", "Indeedee Trick Room", "Pelipper Rain".
  if (primary) {
    const setter = modeSetter(mons, primary);
    add(setter ? `${shortName(setter.species)} ${primary}` : primary);
  }
  // 2. Mega + mode/style, e.g. "Mega Charizard Y Sun", "Mega Dragonite Tailwind", "Mega Kangaskhan Balance".
  if (mega) add(`${fmtMega(mega.species)} ${primary ?? (modes[1] ?? STYLE_FALLBACKS[0])}`);
  // 3. Two-mode teams, e.g. "Sun + Trick Room".
  if (modes.length >= 2) add(`${modes[0]} + ${modes[1]}`);
  // 4. Headline core, e.g. "Garchomp Kingambit Balance" / "Rillaboom Sneasler Rain".
  if (a && b) add(`${shortName(a.species)} ${shortName(b.species)} ${primary ?? STYLE_FALLBACKS[0]}`);
  else if (a) add(`${shortName(a.species)} ${primary ?? STYLE_FALLBACKS[0]}`);
  // 5. Fill with styles so there are always a few to pick from.
  for (const style of STYLE_FALLBACKS) {
    if (out.length >= count) break;
    add(a ? `${shortName(a.species)} ${style}` : style);
  }
  return out.slice(0, count);
}

/** True when the name is the placeholder and a suggestion should replace it. */
export function isPlaceholderName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return !n || n === 'untitled team' || /^untitled team \(copy\)$/.test(n);
}
