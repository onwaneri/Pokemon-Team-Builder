import type { SpSpread } from '@/lib/calc/sp';

export interface OpponentSet {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  sp?: SpSpread;
}

/** OHKO/2HKO/3HKO use the guaranteed (min-roll) result; "survives" means even the max roll doesn't KO. */
export type DamageCondition = 'ohko' | '2hko' | '3hko' | 'survives';

export interface DamageCheck {
  kind: 'damage';
  /** Whether the team mon is the attacker or the defender in this benchmark. */
  teamRole: 'attacker' | 'defender';
  move: string;
  opponent: OpponentSet;
  condition: DamageCondition;
  gameType?: 'Doubles' | 'Singles';
  weather?: string;
  terrain?: string;
}

export interface SpeedCheck {
  kind: 'speed';
  /** "faster" = team mon should move first; "slower" = move last (e.g. a Trick Room setter). */
  comparator: 'faster' | 'slower';
  opponent: OpponentSet;
  tailwind?: 'self' | 'opponent' | 'none';
  trickRoom?: boolean;
}

export type BenchmarkCheck = DamageCheck | SpeedCheck;
export type BenchmarkStatus = 'passing' | 'failing' | 'needs_review';

export interface Benchmark {
  id: string;
  description: string;
  check?: BenchmarkCheck;
  status: BenchmarkStatus;
  detail?: string;
}

export interface TeamMon {
  slot: number;
  nickname: string | null;
  species: string;
  item?: string;
  ability?: string;
  nature: string;
  sp: SpSpread;
  moves: string[];
  computedStats: Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
  role: string;
  benchmarks: Benchmark[];
}
