/**
 * /api/ai-key/models — which models a key can use.
 *
 * POST { provider, apiKey } → { models, recommended }  (key is used for the listing call only)
 * GET                       → same, for the key already connected in the cookie
 */
import { NextResponse } from 'next/server';
import { readByok } from '@/lib/ai/credential';
import { isProviderId, listModels, PROVIDERS } from '@/lib/ai/llm';

export const runtime = 'nodejs';

export async function GET() {
  const byok = await readByok();
  if (!byok) return NextResponse.json({ error: 'No key is connected.' }, { status: 400 });
  return NextResponse.json(await listModels(byok));
}

export async function POST(req: Request) {
  let body: { provider?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isProviderId(body.provider)) return NextResponse.json({ error: 'Unknown provider.' }, { status: 400 });
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) {
    // No key yet: hand back the curated list so the picker is never empty.
    return NextResponse.json({ models: PROVIDERS[body.provider].models, recommended: PROVIDERS[body.provider].defaultModel, live: false });
  }
  const listing = await listModels({ provider: body.provider, apiKey });
  return NextResponse.json({ ...listing, live: true });
}
