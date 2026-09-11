/**
 * GET /api/showdown/team?ref=<id | psim.us/t/… | teams.pokemonshowdown.com/view/…>&password=&regulation=
 * → { paste, team: ParsedMember[], issues: LegalityIssue[] }
 *
 * `paste` is the Showdown export text; `team`/`issues` come from parseTeam against the requested
 * ruleset so callers can preview legality. Most callers just hand `paste` to the normal import flow.
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchShowdownTeamPaste, PsApiError } from '@/lib/showdown/psApi';
import { parseTeam } from '@/lib/showdown/import';
import { getRuleset } from '@/lib/rulesets';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const ref = q.get('ref')?.trim();
  if (!ref) return NextResponse.json({ error: 'Missing ?ref= (team id or share link).' }, { status: 400 });
  const password = q.get('password')?.trim() || undefined;
  const ruleset = getRuleset(q.get('regulation')).id;
  try {
    const paste = await fetchShowdownTeamPaste(ref, password);
    const { members, issues } = parseTeam(paste, ruleset);
    return NextResponse.json({ paste, team: members, issues });
  } catch (e) {
    const status = e instanceof PsApiError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
