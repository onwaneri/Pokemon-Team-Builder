import { NextResponse } from 'next/server';
import {
  calcDamage,
  computeStats,
  TeraRejectedError,
  type MonInput,
  type MoveInput,
  type FieldInput,
} from '@/lib/calc/engine';
import { validateLegality } from '@/lib/data/champions';
import { getRuleset } from '@/lib/rulesets';

// The engine pulls in the vendored @smogon/calc (CJS, ~2.3M) — keep this on the Node runtime.
export const runtime = 'nodejs';

interface CalcRequest {
  attacker: MonInput;
  defender: MonInput;
  move: MoveInput;
  field?: FieldInput;
  regulation?: string;
}

export async function POST(req: Request) {
  let body: CalcRequest;
  try {
    body = (await req.json()) as CalcRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { attacker, defender, move, field } = body ?? {};
  const ruleset = getRuleset(body?.regulation);
  if (!attacker?.species || !defender?.species || !move?.name) {
    return NextResponse.json(
      { error: 'attacker.species, defender.species and move.name are required.' },
      { status: 400 },
    );
  }

  const issues = [
    ...validateLegality({
      species: attacker.species,
      item: attacker.item,
      ability: attacker.ability,
      moves: [move.name],
    }, ruleset.id),
    ...validateLegality({ species: defender.species, item: defender.item, ability: defender.ability }, ruleset.id),
  ];
  if (issues.length) {
    return NextResponse.json({ error: `Not legal in ${ruleset.short}.`, issues }, { status: 400 });
  }

  try {
    const result = calcDamage(attacker, defender, move, field);
    return NextResponse.json({
      result,
      attackerStats: computeStats(attacker),
      defenderStats: computeStats(defender),
    });
  } catch (e) {
    const status = e instanceof TeraRejectedError ? 400 : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Calculation failed.' }, { status });
  }
}
