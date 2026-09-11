/**
 * POST /api/team-blurb
 *
 * Generates a concise 2–3 sentence AI overview of how the team functions:
 * archetype, primary win condition, speed-control plan, Mega note (if applicable).
 *
 * Body: { team: (TeamMon | null)[] }
 * Response: { blurb: string }
 *
 * Returns { blurb: '' } (status 200) when:
 *   - Fewer than 2 filled slots (not enough context for a meaningful blurb).
 *   - The visitor has no AI key connected (blurbs are an ambient feature and never use the free tier).
 *   - Gemini returns an error (blurb is best-effort, never blocks saving).
 */
import { NextResponse } from 'next/server';
import { resolveAi } from '@/lib/ai/credential';
import { computeStats } from '@/lib/calc/engine';
import { championsMeta } from '@/lib/data/meta';
import type { TeamMon } from '@/lib/benchmarks/types';
import { getRuleset, type RulesetId } from '@/lib/rulesets';

export const runtime = 'nodejs';


const systemFor = (ruleset: RulesetId) => `${championsMeta(ruleset)}

You are a Pokémon Champions (VGC doubles) team analyst. Write a 2–3 sentence team overview describing how this team functions. Cover: the team archetype, the primary win condition, and the speed-control plan. If the team carries multiple Pokémon with Mega Evolution, note that only one can Mega Evolve per battle.

Hard rules:
- Reference ONLY the Pokémon, moves, items, and abilities present in the provided team data.
- No Terastallization — it does not exist in Pokémon Champions.
- Use SP language (e.g. "32 Speed SPs"), never EVs or IVs.
- Do NOT include any usage percentages or meta-share claims — that data is not available here.
- Do NOT include specific damage numbers.
- Return plain text only (no markdown, no bullet points, no headers).`;


export async function POST(req: Request) {
  let body: { team?: (TeamMon | null)[]; regulation?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ blurb: '' });
  }

  const filledSlots = (body.team ?? []).filter((m): m is TeamMon => m !== null);

  // Not enough mons to form a meaningful overview.
  if (filledSlots.length < 2) {
    return NextResponse.json({ blurb: '' });
  }

  // Ambient feature: only runs on the visitor's own key; never spends the free tier.
  const grant = await resolveAi(req, { interactive: false });
  if (!grant) {
    return NextResponse.json({ blurb: '' });
  }

  // Recompute stats server-side so the model sees accurate numbers.
  const monsWithStats = filledSlots.map((mon) => {
    let computedStats = mon.computedStats;
    try {
      computedStats = computeStats({
        species: mon.species,
        ability: mon.ability,
        item: mon.item,
        nature: mon.nature,
        sp: mon.sp,
      });
    } catch {
      // Illegal species or other engine error — keep the stored stats.
    }
    return {
      slot: mon.slot,
      species: mon.species,
      item: mon.item ?? '',
      ability: mon.ability ?? '',
      nature: mon.nature,
      sp: mon.sp,
      moves: mon.moves,
      computedStats,
    };
  });

  try {
    const prompt = `Team data:\n${JSON.stringify(monsWithStats, null, 1)}\n\nWrite a 2–3 sentence overview of how this team functions.`;
    const resp = await grant.client.generate({ system: systemFor(getRuleset(body.regulation).id), messages: [{ role: 'user', text: prompt }], maxTokens: 400 });
    const blurb = resp.text.trim();
    return NextResponse.json({ blurb }, { headers: grant.headers });
  } catch (err) {
    console.warn('[team-blurb] model error:', (err as Error).message);
    return NextResponse.json({ blurb: '' });
  }
}
