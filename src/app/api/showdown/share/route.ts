/**
 * POST /api/showdown/share { paste, title?, author?, notes? } → { url }
 * Creates a PokePaste (pokepast.es) and returns its URL.
 */
import { NextResponse } from 'next/server';
import { createPokePaste, PsApiError } from '@/lib/showdown/psApi';

export const runtime = 'nodejs';

const MAX_PASTE = 20_000;

export async function POST(req: Request) {
  let body: { paste?: string; title?: string; author?: string; notes?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const paste = body.paste?.trim();
  if (!paste) return NextResponse.json({ error: 'Nothing to share: the paste is empty.' }, { status: 400 });
  if (paste.length > MAX_PASTE) return NextResponse.json({ error: 'Paste is too long to share.' }, { status: 413 });
  try {
    const url = await createPokePaste({
      paste,
      title: body.title?.slice(0, 200),
      author: body.author?.slice(0, 100),
      notes: body.notes?.slice(0, 2000),
    });
    return NextResponse.json({ url });
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
