/**
 * POST /api/build-team
 *
 * Body: { prompt: string, team: (TeamMon | null)[], regulation?: RulesetId }
 * Response: { team: (TeamMon | null)[], summary: string, toolCalls: { name }[] }
 *
 * Fills the empty slots of `team` around the filled ones (which are kept untouched). See
 * lib/ai/buildTeam.ts for the process and validation. Interactive: runs on the visitor's key or
 * spends one free request.
 */
import { NextResponse } from 'next/server';
import { buildTeam } from '@/lib/ai/buildTeam';
import type { TeamMon } from '@/lib/benchmarks/types';
import { getRuleset } from '@/lib/rulesets';
import { resolveAi, AiDenied, denialResponse } from '@/lib/ai/credential';
import { LlmError } from '@/lib/ai/llm';

export const runtime = 'nodejs';
// Research + validation loops can take a while.
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: { prompt?: string; team?: (TeamMon | null)[]; regulation?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const team = Array.isArray(body.team) ? body.team : [];

  let grant;
  try {
    grant = await resolveAi(req, { interactive: true });
  } catch (e) {
    if (e instanceof AiDenied) return denialResponse(e);
    throw e;
  }

  try {
    const result = await buildTeam({ client: grant.client, prompt: body.prompt ?? '', team, regulation: getRuleset(body.regulation).id });
    return NextResponse.json({
      team: result.team,
      summary: result.summary,
      toolCalls: result.toolCalls.map((t) => ({ name: t.name })),
    }, { headers: grant.headers });
  } catch (e) {
    await grant.refund();
    const status = e instanceof LlmError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Team build failed.' }, { status, headers: grant.headers });
  }
}
