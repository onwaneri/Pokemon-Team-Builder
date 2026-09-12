/**
 * GET /api/learnset?pokemon=<name>&regulation=<id>
 *
 * The species' legal move pool split into learnable / unverified (see learnsets.ts for the
 * Gen 9 graft caveats). Pure dex data, so it is cached hard at the edge and in the browser.
 */
import { NextRequest, NextResponse } from 'next/server';
import { learnsetFor } from '@/lib/data/learnsets';
import { isLegalSpecies } from '@/lib/data/champions';
import { getRuleset } from '@/lib/rulesets';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const pokemon = req.nextUrl.searchParams.get('pokemon');
  if (!pokemon) return NextResponse.json({ error: 'Missing pokemon param' }, { status: 400 });
  const ruleset = getRuleset(req.nextUrl.searchParams.get('regulation')).id;
  if (!isLegalSpecies(pokemon, ruleset)) return NextResponse.json({ error: 'Unknown species for this ruleset' }, { status: 404 });

  const data = await learnsetFor(pokemon, ruleset);
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800' },
  });
}
