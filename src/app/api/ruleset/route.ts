/**
 * GET /api/ruleset?id=<RulesetId>
 *
 * Which ruleset is active and where its usage numbers actually come from. The header badge uses
 * `usageFallbackFrom` to say "usage: Reg M-B data" while Pikalytics has not published a newer
 * regulation yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRuleset, RULESET_IDS, RULESETS } from '@/lib/rulesets';
import { resolveUsageFormat } from '@/lib/data/usage';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const ruleset = getRuleset(req.nextUrl.searchParams.get('id'));
  const source = await resolveUsageFormat(ruleset.id).catch(() => ({ format: ruleset.pikalyticsFormats[0], fallbackFrom: null }));
  return NextResponse.json({
    id: ruleset.id,
    label: ruleset.label,
    short: ruleset.short,
    dates: ruleset.dates,
    usageFormat: source.format,
    usageFallbackFrom: source.fallbackFrom,
    available: RULESET_IDS.map((id) => ({ id, label: RULESETS[id].label, short: RULESETS[id].short })),
  });
}
