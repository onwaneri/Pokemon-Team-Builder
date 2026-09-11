/**
 * GET /api/showdown/profile?user=<name>
 * → { name, userid, ratings: { format, elo, gxe, w, l }[] }   (Champions formats only)
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchProfile, PsApiError } from '@/lib/showdown/psApi';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get('user')?.trim();
  if (!user) return NextResponse.json({ error: 'Missing ?user=' }, { status: 400 });
  try {
    return NextResponse.json(await fetchProfile(user));
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
