/**
 * GET /api/showdown/replays?user=<name>&format=<formatId>&limit=<n>
 * → { replays: { id, format, formatId, players, uploadtime, url }[] }
 * Without `format`, returns Champions-format replays from the first page.
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchRecentReplays, PsApiError } from '@/lib/showdown/psApi';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const user = q.get('user')?.trim();
  if (!user) return NextResponse.json({ error: 'Missing ?user=' }, { status: 400 });
  const format = q.get('format')?.trim() || undefined;
  const limit = Math.min(51, Math.max(1, Number(q.get('limit')) || 51));
  try {
    const replays = await fetchRecentReplays(user, format);
    return NextResponse.json({ replays: replays.slice(0, limit) });
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
