/**
 * POST /api/build-team — one round of the team builder per request.
 *
 * Start:    { prompt, team, regulation? }  → charges one free request (or uses the visitor's key),
 *                                            prepares the build, runs the first round.
 * Continue: { state }                       → runs the next round on the signed state from the
 *                                            previous response; never re-charges.
 * Response: { state, progress, done }      where `done` is { team, summary, toolCalls } on the
 *                                            round that produced an accepted team, else null.
 *
 * Splitting the loop keeps every request under a single model call, so it fits serverless
 * request limits regardless of how many research rounds the model needs.
 */
import { NextResponse } from 'next/server';
import { startBuild, stepBuild, type BuildState } from '@/lib/ai/buildTeam';
import type { TeamMon } from '@/lib/benchmarks/types';
import { getRuleset } from '@/lib/rulesets';
import { resolveAi, AiDenied, denialResponse, sealState, openState } from '@/lib/ai/credential';
import { LlmError } from '@/lib/ai/llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { prompt?: string; team?: (TeamMon | null)[]; regulation?: string; state?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const continuing = typeof body.state === 'string';
  let state: BuildState | null = null;
  if (continuing) {
    state = openState<BuildState>(body.state);
    if (!state || state.v !== 1) return NextResponse.json({ error: 'The build state is invalid or expired. Start again.' }, { status: 400 });
  }

  let grant;
  try {
    grant = await resolveAi(req, { interactive: true, consume: !continuing });
  } catch (e) {
    if (e instanceof AiDenied) return denialResponse(e);
    throw e;
  }

  try {
    if (!state) {
      state = await startBuild({ prompt: body.prompt ?? '', team: Array.isArray(body.team) ? body.team : [], regulation: getRuleset(body.regulation).id });
    }
    const step = await stepBuild(grant.client, state);
    return NextResponse.json(
      { state: step.done ? null : sealState(step.state), progress: step.progress, round: step.state.round, done: step.done },
      { headers: grant.headers },
    );
  } catch (e) {
    if (!continuing) await grant.refund();
    const status = e instanceof LlmError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Team build failed.' }, { status, headers: grant.headers });
  }
}
