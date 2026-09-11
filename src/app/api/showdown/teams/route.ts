/**
 * GET /api/showdown/teams?user=<name>&format=<formatId>
 * → { teams: { teamid, title, format, date }[] }   (public teams; Champions-only when no format)
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchPublicTeams, PsApiError } from '@/lib/showdown/psApi';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const user = q.get('user')?.trim();
  if (!user) return NextResponse.json({ error: 'Missing ?user=' }, { status: 400 });
  const format = q.get('format')?.trim() || undefined;
  try {
    return NextResponse.json({ teams: await fetchPublicTeams(user, format) });
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
