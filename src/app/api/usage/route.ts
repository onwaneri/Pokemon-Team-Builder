import { NextRequest, NextResponse } from 'next/server';
import { fetchUsage, resolveUsageFormat } from '@/lib/data/usage';
import { getRuleset } from '@/lib/rulesets';

export async function GET(req: NextRequest) {
  const pokemon = req.nextUrl.searchParams.get('pokemon');
  if (!pokemon) return NextResponse.json({ error: 'Missing pokemon param' }, { status: 400 });

  const ruleset = getRuleset(req.nextUrl.searchParams.get('regulation')).id;
  const [data, source] = await Promise.all([fetchUsage(pokemon, ruleset), resolveUsageFormat(ruleset)]);
  if (!data) return NextResponse.json({ error: 'No usage data for this species' }, { status: 404 });

  return NextResponse.json({ ...data, usageFormat: source.format, usageFallbackFrom: source.fallbackFrom }, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200, max-age=0' },
  });
}
