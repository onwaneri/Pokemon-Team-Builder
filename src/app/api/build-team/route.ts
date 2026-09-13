/**
 * POST /api/build-team — one phase of the team builder per request (plan → draft → refine).
 *
 * Start:    { prompt, team, regulation? }  → charges one free request (or uses the visitor's key),
 *                                            prepares the build, runs the plan phase.
 * Continue: { state }                       → runs the next phase on the signed state from the
 *                                            previous response; never re-charges.
 * Response: { state, progress, done }      where `done` is { team, summary, toolCalls } on the
 *                                            refine phase, else null.
 *
 * Each phase is bounded by one capped model call or one batch of capped fetches (see
 * lib/ai/buildTeam.ts), so a request can never outlive the serverless function limit, and every
 * phase has a deterministic fallback, so a build never ends without a legal team.
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
    if (!state || state.v !== 2) return NextResponse.json({ error: 'The build state is invalid or expired. Start again.' }, { status: 400 });
  }

  let grant;
  try {
    grant = await resolveAi(req, { job: 'build', interactive: true, consume: !continuing });
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
