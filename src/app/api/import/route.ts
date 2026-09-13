import { calcSpecies } from '@/lib/data/megas';
import { getSpecies } from '@/lib/data/champions';
import { NextResponse } from 'next/server';
import { parseTeam } from '@/lib/showdown/import';
import { computeStats } from '@/lib/calc/engine';
import { ZERO_STATS } from '@/lib/calc/sp';
import { inferTeam } from '@/lib/ai/benchmarks';
import { canLearn } from '@/lib/data/learnsets';
import type { LegalityIssue } from '@/lib/data/champions';
import type { TeamMon } from '@/lib/benchmarks/types';
import { getRuleset } from '@/lib/rulesets';
import { resolveAi } from '@/lib/ai/credential';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { paste?: string; regulation?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body.paste?.trim()) {
    return NextResponse.json({ error: 'Paste a Showdown-style team.' }, { status: 400 });
  }

  const ruleset = getRuleset(body.regulation).id;
  const { members, issues } = parseTeam(body.paste, ruleset);
  if (members.length === 0) {
    return NextResponse.json({ error: 'No valid sets found in the paste.' }, { status: 400 });
  }
  // "Charizard @ Charizardite X" is a Mega-capable slot: hold it in the Mega forme (the editor's
  // forme toggle shows either), with the Mega's ability.
  for (const m of members) {
    const forme = calcSpecies(m.species, m.item, ruleset);
    if (forme !== m.species) {
      m.species = forme;
      m.ability = getSpecies(forme)?.abilities?.[0] ?? m.ability;
    }
  }

  // Species↔move check (Gen 9 Showdown learnsets plus Champions usage evidence; unknown moves pass).
  for (const m of members) {
    for (const mv of m.moves.filter(Boolean)) {
      if ((await canLearn(m.species, mv, ruleset)) === 'no') {
        issues.push({
          field: 'move',
          value: mv,
          message: `${m.species} cannot learn ${mv} (per Gen 9 Showdown learnset data, and no Champions usage shows it).`,
        } satisfies LegalityIssue);
      }
    }
  }

  const withStats = members.map((m) => {
    let computedStats = ZERO_STATS;
    try {
      computedStats = computeStats({ species: m.species, ability: m.ability, item: m.item, nature: m.nature, sp: m.sp });
    } catch { /* illegal species etc. — surfaced via issues */ }
    return { ...m, computedStats };
  });

  // Infer one-line roles only — no auto-generated benchmarks.
  const grant = await resolveAi(req, { job: 'import', interactive: false });
  const inferred = await inferTeam(withStats, ruleset, grant?.client ?? null);
  const roleBySlot = new Map(inferred.map((i) => [i.slot, i.role]));

  const team: TeamMon[] = withStats.map((m) => ({
    ...m,
    role: roleBySlot.get(m.slot) ?? '',
    benchmarks: [],
  }));

  return NextResponse.json({ team, issues });
}
