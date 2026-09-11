import { NextResponse } from 'next/server';
import { runChampionsChat, type ChatMessage } from '@/lib/ai/gemini';
import type { TeamMon } from '@/lib/benchmarks/types';
import type { ScreenContext } from '@/lib/ai/types';
import { getRuleset } from '@/lib/rulesets';
import { resolveAi, AiDenied, denialResponse } from '@/lib/ai/credential';
import { LlmError } from '@/lib/ai/llm';

// Uses the calc engine (vendored @smogon/calc) + provider SDKs — keep on the Node runtime.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { messages?: ChatMessage[]; team?: TeamMon[]; context?: ScreenContext; regulation?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return NextResponse.json({ error: 'messages is required.' }, { status: 400 });
  }

  // Interactive: the visitor's own key, or one of their free requests.
  let grant;
  try {
    grant = await resolveAi(req, { interactive: true });
  } catch (e) {
    if (e instanceof AiDenied) return denialResponse(e);
    throw e;
  }

  try {
    const reply = await runChampionsChat(grant.client, messages, body.team ?? undefined, body.context ?? undefined, getRuleset(body.regulation).id);
    return NextResponse.json(reply, { headers: grant.headers });
  } catch (e) {
    await grant.refund();
    const status = e instanceof LlmError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Chat failed.' }, { status, headers: grant.headers });
  }
}
