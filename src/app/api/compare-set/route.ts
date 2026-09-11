/**
 * POST /api/compare-set
 *
 * Body: { mode: 'calc' | 'speed', focus: FocusMon[], teamSpecies?: string[], count?: number }
 * Response: { opponents: CompareOpponent[], source: 'ai' | 'rankings' }
 *
 * Opponent sets are built from live usage data (see lib/ai/compareSet.ts); the model only picks
 * which species are relevant.
 */
import { NextResponse } from 'next/server';
import { generateCompareSet, type CompareSetInput } from '@/lib/ai/compareSet';
import { isLegalSpecies } from '@/lib/data/champions';
import { getRuleset } from '@/lib/rulesets';
import { resolveAi } from '@/lib/ai/credential';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: Partial<CompareSetInput>;
  try {
    body = (await req.json()) as Partial<CompareSetInput>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const mode = body.mode === 'speed' ? 'speed' : body.mode === 'calc' ? 'calc' : null;
  if (!mode) return NextResponse.json({ error: 'mode must be "calc" or "speed".' }, { status: 400 });
  const regulation = getRuleset(body.regulation).id;
  const focus = (body.focus ?? []).filter((f) => f && typeof f.species === 'string' && isLegalSpecies(f.species, regulation));
  if (!focus.length) return NextResponse.json({ error: 'focus must include at least one legal species.' }, { status: 400 });

  try {
    const grant = await resolveAi(req, { interactive: false });
    const data = await generateCompareSet({ mode, focus, teamSpecies: body.teamSpecies, count: body.count, regulation, client: grant?.client ?? null });
    return NextResponse.json(data, { headers: grant?.headers ?? {} });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? 'Could not build a comparison set.' }, { status: 500 });
  }
}
