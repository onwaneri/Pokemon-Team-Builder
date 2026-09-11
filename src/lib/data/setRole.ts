import type { PopularSet } from './usage';
import type { FormLists } from './champions';

export function describeSet(s: PopularSet, moveInfo: FormLists['moveInfo']): string {
  const mv = s.moves.map((m) => m.toLowerCase());
  const sp = (s.sp ?? {}) as Record<string, number>;
  const nature = s.nature?.toLowerCase() ?? '';

  // High-confidence move-based roles
  if (mv.includes('trick room')) return 'Trick Room setter';
  if (mv.includes('tailwind')) return 'Tailwind setter';
  if (mv.includes('follow me') || mv.includes('rage powder')) return 'Redirection support';
  if (mv.includes('spore') || mv.includes('sleep powder')) return 'Sleep support';
  if (mv.includes('light screen') && mv.includes('reflect')) return 'Dual screens';
  if (mv.some((m) => ['swords dance', 'dragon dance', 'nasty plot', 'calm mind', 'quiver dance'].includes(m)))
    return 'Setup sweeper';
  if (mv.includes('helping hand')) return 'Support attacker';
  if (mv.some((m) => ['will-o-wisp', 'thunder wave', 'toxic'].includes(m))) return 'Status spreader';

  const pivot = mv.some((m) => ['u-turn', 'volt switch', 'parting shot', 'flip turn'].includes(m));

  // Offense type: SP data > move categories > nature
  let physCount = 0, specCount = 0;
  for (const moveName of s.moves) {
    const cat = moveInfo[moveName]?.category;
    if (cat === 'Physical') physCount++;
    else if (cat === 'Special') specCount++;
  }
  const hasSpData = Object.keys(sp).length > 0;
  const atk = sp['atk'] ?? 0, spa = sp['spa'] ?? 0;
  const offenseType: 'physical' | 'special' | '' =
    hasSpData ? (atk > spa ? 'physical' : spa > atk ? 'special' : '') :
    physCount !== specCount ? (physCount > specCount ? 'physical' : 'special') :
    ['adamant', 'brave', 'naughty', 'lonely'].includes(nature) ? 'physical' :
    ['modest', 'quiet', 'rash', 'mild'].includes(nature) ? 'special' : '';
  const t = offenseType ? `${offenseType} ` : '';

  // Bulk + speed profile
  const hp = sp['hp'] ?? 0, def = sp['def'] ?? 0, spd2 = sp['spd'] ?? 0, spe = sp['spe'] ?? 0;
  const bulky = hasSpData && (hp >= 20 || def + spd2 >= 28);
  const fast = hasSpData ? spe >= 20 : ['timid', 'jolly', 'naive', 'hasty'].includes(nature);
  const trNature = ['brave', 'quiet', 'relaxed', 'sassy'].includes(nature);

  if (trNature) return `TR ${t}attacker`;
  if (bulky && fast) return pivot ? 'Fast bulky pivot' : `Bulky ${t}sweeper`;
  if (bulky) return pivot ? 'Bulky pivot' : `Bulky ${t}attacker`;
  if (fast) return pivot ? `${cap(t)}pivot` : `${cap(t)}sweeper`;
  if (pivot) return `${cap(t)}pivot`;
  if (['bold', 'impish', 'lax', 'calm', 'careful', 'gentle'].includes(nature)) return `Bulky ${t}attacker`;

  return t ? `${cap(t)}attacker` : 'Standard set';
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
