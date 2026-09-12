/**
 * POST /api/threats
 *
 * Body: { species, ability?, item?, nature?, sp?, moves?, opponents?, regulation? }
 * Response: ThreatMatrixResult — per-opponent two-way KO verdicts plus a prompt-ready summary.
 *
 * The whole matrix is computed by `src/lib/calc/threats.ts`; this handler only validates the set
 * against the active regulation and hands it over. Anything the caller omits is filled from live
 * usage data, so `{ "species": "Garchomp" }` is a valid body. No AI is involved and no key is
 * needed — every number comes from the engine.
 *
 * Bounded by design: opponents are capped at 30 and both sides at four moves, so the worst case is
 * 240 damage calcs plus (at most) 30 cached Pikalytics fetches — one serverless request.
 */
import { NextResponse } from 'next/server';
import { computeThreatMatrix, MAX_OPPONENTS, type ThreatMatrixArgs } from '@/lib/calc/threats';
import { validateLegality } from '@/lib/data/champions';
import { getRuleset } from '@/lib/rulesets';
import { TeraRejectedError } from '@/lib/calc/engine';

// The engine pulls in the vendored @smogon/calc (CJS, ~2.3M) — keep this on the Node runtime.
export const runtime = 'nodejs';

interface ThreatsRequest extends ThreatMatrixArgs {
  regulation?: string;
}

export async function POST(req: Request) {
  let body: ThreatsRequest;
  try {
    body = (await req.json()) as ThreatsRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body?.species || typeof body.species !== 'string') {
    return NextResponse.json({ error: 'species is required.' }, { status: 400 });
  }
  const ruleset = getRuleset(body.regulation);

  const moves = Array.isArray(body.moves) ? body.moves.filter((m) => typeof m === 'string' && m) : undefined;
  const issues = validateLegality(
    { species: body.species, item: body.item, ability: body.ability, moves },
    ruleset.id,
  );
  if (issues.length) {
    return NextResponse.json({ error: `Not legal in ${ruleset.short}.`, issues }, { status: 400 });
  }

  const opponents =
    body.opponents == null ? undefined : Math.max(1, Math.min(MAX_OPPONENTS, Math.round(Number(body.opponents) || 0)));

  try {
    const result = await computeThreatMatrix(
      { species: body.species, ability: body.ability, item: body.item, nature: body.nature, sp: body.sp, moves },
      { ruleset: ruleset.id, opponents },
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof TeraRejectedError ? 400 : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Could not build the threat matrix.' }, { status });
  }
}
