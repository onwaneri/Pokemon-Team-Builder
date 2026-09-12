/**
 * /api/ai-key — connect, inspect, or remove the visitor's own AI key.
 *
 * GET    → { byok, free, identity, providers }   (never the key itself; a fingerprint at most)
 * POST   { provider, apiKey } → validates the key with the provider, then seals it into an
 *          httpOnly cookie (see lib/ai/credential.ts). Nothing is written server-side.
 * DELETE → clears the cookie.
 *
 * Visitors pick a provider only. Which model each job runs on is decided server-side
 * (modelFor in lib/ai/llm.ts); the GET response lists those so the panel can say what it uses.
 */
import { NextResponse } from 'next/server';
import { aiStatus, writeByok, clearByok } from '@/lib/ai/credential';
import { isProviderId, keyFingerprint, PROVIDERS, PROVIDER_IDS, validateCredential } from '@/lib/ai/llm';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const status = await aiStatus(req);
  return NextResponse.json({
    ...status,
    providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label, models: PROVIDERS[id].models, keyPrefixHint: PROVIDERS[id].keyPrefixHint, consoleUrl: PROVIDERS[id].consoleUrl })),
  });
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
  if (apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) return NextResponse.json({ error: 'That does not look like an API key.' }, { status: 400 });

  const check = await validateCredential({ provider: body.provider, apiKey });
  if (!check.ok) return NextResponse.json({ error: `The ${PROVIDERS[body.provider].label} key was rejected: ${check.error}` }, { status: 400 });

  await writeByok({ provider: body.provider, apiKey });
  return NextResponse.json({ ok: true, byok: { provider: body.provider, fingerprint: keyFingerprint(apiKey) } });
}

export async function DELETE() {
  await clearByok();
  return NextResponse.json({ ok: true });
}
