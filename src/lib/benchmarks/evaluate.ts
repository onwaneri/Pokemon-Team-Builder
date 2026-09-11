/**
 * Evaluate a benchmark's pass/fail using the deterministic engine — never the model.
 * The model supplies the natural-language description + a machine-checkable `check`; this turns that
 * check into an actual calc/speed comparison and returns the status with the engine's own detail line.
 */
import { calcDamage, computeStats, type MonInput } from '@/lib/calc/engine';
import type { SpSpread } from '@/lib/calc/sp';
import type {
  Benchmark,
  BenchmarkCheck,
  BenchmarkStatus,
  DamageCheck,
  OpponentSet,
  SpeedCheck,
} from './types';

export interface EvalMon {
  species: string;
  ability?: string;
  item?: string;
  nature: string;
  sp: SpSpread;
}

function teamMonInput(m: EvalMon): MonInput {
  return { species: m.species, ability: m.ability, item: m.item, nature: m.nature, sp: m.sp };
}
function opponentInput(o: OpponentSet): MonInput {
  return { species: o.species, ability: o.ability, item: o.item, nature: o.nature ?? 'Hardy', sp: o.sp };
}

/**
 * A benchmark is only as honest as its opponent set. Unspecified fields fall back to defaults
 * (neutral nature, 0 SP, slot-0 ability, no item) — state those assumptions in the detail line so a
 * "passing" result is never mistaken for a check against a real invested set.
 */
function opponentAssumptions(o: OpponentSet, opts?: { speedOnly?: boolean }): string {
  const notes: string[] = [];
  if (!o.nature) notes.push('neutral nature');
  if (!o.sp || Object.keys(o.sp).length === 0) notes.push('0 SP');
  if (!opts?.speedOnly) {
    if (!o.ability) notes.push('default ability');
    if (!o.item) notes.push('no item');
  }
  return notes.length ? ` — assumes ${notes.join(', ')} for ${o.species}` : '';
}

function evalDamage(teamMon: EvalMon, check: DamageCheck): { status: BenchmarkStatus; detail: string } {
  const team = teamMonInput(teamMon);
  const opp = opponentInput(check.opponent);
  const attacker = check.teamRole === 'attacker' ? team : opp;
  const defender = check.teamRole === 'attacker' ? opp : team;
  const field = { gameType: check.gameType ?? 'Doubles', weather: check.weather, terrain: check.terrain };
  const r = calcDamage(attacker, defender, { name: check.move }, field);

  let pass: boolean;
  switch (check.condition) {
    case 'ohko':
      pass = r.minPct >= 100; // guaranteed
      break;
    case '2hko':
      pass = r.minPct >= 50;
      break;
    case '3hko':
      pass = r.minPct >= 100 / 3;
      break;
    case 'survives':
      pass = r.maxPct < 100; // even the max roll doesn't KO
      break;
    default:
      return { status: 'needs_review', detail: `Unknown condition.` };
  }
  const flagNote = r.flags.length ? ` [${r.flags.join(' ')}]` : '';
  return {
    status: pass ? 'passing' : 'failing',
    detail: `${r.desc || `${r.minPct}–${r.maxPct}%`}${opponentAssumptions(check.opponent)}${flagNote}`,
  };
}

function effectiveSpe(spe: number, tailwind: boolean): number {
  return tailwind ? spe * 2 : spe;
}

function evalSpeed(teamMon: EvalMon, check: SpeedCheck): { status: BenchmarkStatus; detail: string } {
  const teamSpe = computeStats(teamMonInput(teamMon)).spe;
  const oppSpe = computeStats(opponentInput(check.opponent)).spe;
  const teamEff = effectiveSpe(teamSpe, check.tailwind === 'self');
  const oppEff = effectiveSpe(oppSpe, check.tailwind === 'opponent');

  const twNote = check.tailwind && check.tailwind !== 'none' ? `, Tailwind on ${check.tailwind}` : '';
  const trNote = check.trickRoom ? ', Trick Room' : '';
  const detailBase = `Team ${teamEff} Spe vs ${check.opponent.species} ${oppEff} Spe${twNote}${trNote}${opponentAssumptions(check.opponent, { speedOnly: true })}`;

  if (teamEff === oppEff) {
    return { status: 'needs_review', detail: `${detailBase} — speed tie (50/50), train +1 to settle.` };
  }
  const teamMovesFirst = check.trickRoom ? teamEff < oppEff : teamEff > oppEff;
  const pass = check.comparator === 'faster' ? teamMovesFirst : !teamMovesFirst;
  return { status: pass ? 'passing' : 'failing', detail: detailBase };
}

export function evaluateCheck(teamMon: EvalMon, check: BenchmarkCheck): { status: BenchmarkStatus; detail: string } {
  try {
    return check.kind === 'damage' ? evalDamage(teamMon, check) : evalSpeed(teamMon, check);
  } catch (e) {
    return { status: 'needs_review', detail: (e as Error).message };
  }
}

/** Evaluate every benchmark that has a machine-checkable spec; leave the rest as needs_review. */
export function evaluateBenchmarks(teamMon: EvalMon, benchmarks: Benchmark[]): Benchmark[] {
  return benchmarks.map((b) => {
    if (!b.check) return { ...b, status: 'needs_review' };
    const { status, detail } = evaluateCheck(teamMon, b.check);
    return { ...b, status, detail };
  });
}
