/**
 * GET /api/showdown/replay-analysis?user=<name>&format=<formatId>&limit=<n>
 * → ReplayAggregate: { user, userid, formatId, format, candidates, requested, analysed,
 *                      excluded[], record, bringRates[], leads[], vsOpponentMarker[],
 *                      withOwnMarker[], mostFaced[], games[] }
 *
 * Reads the actual battle logs of a user's recent replays and counts what they bring, what they
 * lead, and what they lose to. Deterministic: no model is involved. Without `format`, the newest
 * Champions format in the user's recent replays is used, and only that format is counted.
 * `limit` is clamped to 1…25 so the whole analysis fits in one serverless invocation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { analyseUserReplays, MAX_REPLAYS } from '@/lib/showdown/replayAnalysis';
import { PsApiError } from '@/lib/showdown/psApi';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const user = q.get('user')?.trim();
  if (!user) return NextResponse.json({ error: 'Missing ?user=' }, { status: 400 });
  const formatId = q.get('format')?.trim() || undefined;
  const raw = Number(q.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(MAX_REPLAYS, Math.trunc(raw)) : undefined;
  try {
    return NextResponse.json(await analyseUserReplays({ user, formatId, limit }));
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
