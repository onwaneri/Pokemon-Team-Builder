/**
 * Pokémon Showdown public API client. Server-only: the teams DB and PokePaste have no CORS for
 * our origin, so everything here is called from /api/showdown/* route handlers, which also lets
 * us keep short in-process caches so a panel re-render never hammers Showdown.
 *
 * Endpoints (all confirmed live, no auth):
 *   https://pokemonshowdown.com/users/<userid>.json                 profile + per-format ratings
 *   https://replay.pokemonshowdown.com/search.json?user=&format=    recent replays (51/page)
 *   https://teams.pokemonshowdown.com/api/searchteams?owner=&format= public teams (JSON, `]`-prefixed)
 *   https://teams.pokemonshowdown.com/api/getteam?teamid=&password= one team incl. export text
 *   POST https://pokepast.es/create                                  303 → Location: paste URL
 *
 * We never ask for or store a Showdown account password. The `password` here is the per-team
 * share secret embedded in psim.us/t/<id>-<password> links, which the owner chose to share.
 *
 * Replay *logs* are read by `./replayAnalysis.ts`, which shares this module's User-Agent and
 * uses `fetchRecentReplays` to pick which replays to read.
 */
import { RULESET_IDS, RULESETS } from '@/lib/rulesets';

/** Sent on every Showdown/PokePaste request, here and in ./replayAnalysis.ts. */
export const PS_USER_AGENT = 'VGC-Champions-Tool/1.0';
const CHAMPIONS_PREFIX = 'gen9champions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FormatRating {
  format: string;
  elo: number;
  gxe: number;
  w: number;
  l: number;
}

export interface ShowdownProfile {
  name: string;
  userid: string;
  /** Champions formats only, ordered with the app's known regulations first (newest first). */
  ratings: FormatRating[];
}

export interface ShowdownReplay {
  id: string;
  /** Display name as Showdown reports it, e.g. "[Gen 9] Champions VGC 2026 Reg M-C". */
  format: string;
  /** Format id derived from the replay id, e.g. gen9championsvgc2026regmc. */
  formatId: string;
  players: string[];
  uploadtime: number;
  url: string;
}

export interface ShowdownPublicTeam {
  teamid: number;
  title: string;
  format: string;
  date: string;
}

export class PsApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'PsApiError';
    this.status = status;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Showdown user id: lowercase alphanumerics of the display name. */
export function toUserId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isChampionsFormat(formatId: string): boolean {
  return formatId.startsWith(CHAMPIONS_PREFIX);
}

/** Known regulation format ids, newest regulation first. */
function knownChampionsFormats(): string[] {
  return [...RULESET_IDS].reverse().map((id) => RULESETS[id].pikalyticsFormats[0]);
}

/** Human label for a Champions format id (falls back to the raw id). */
export function formatLabel(formatId: string): string {
  for (const id of RULESET_IDS) {
    if (RULESETS[id].pikalyticsFormats[0] === formatId) return RULESETS[id].label;
  }
  const m = formatId.match(/^gen9championsvgc(\d{4})reg([a-z]+)$/);
  if (m) return `VGC ${m[1]} Reg ${m[2].toUpperCase().split('').join('-')}`;
  return formatId;
}

const cache = new Map<string, { expires: number; value: unknown }>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { expires: Date.now() + ttlMs, value });
  // Keep the map bounded; entries are tiny but a long-running dev server should not grow forever.
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  }
  return value;
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': PS_USER_AGENT, Accept: 'application/json, text/plain, */*', ...(init?.headers ?? {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    throw new PsApiError(`Could not reach ${new URL(url).host}: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/** Parse a Showdown JSON body, tolerating the `]` prefix the teams DB prepends. */
function parseJson<T>(text: string, what: string): T {
  const body = text.replace(/^\s*\]/, '').trim();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new PsApiError(`Showdown returned a non-JSON response for ${what}.`, 502);
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

interface RawProfile {
  username?: string;
  userid?: string;
  registertime?: number;
  ratings?: Record<string, { elo?: number; gxe?: number; w?: number; l?: number }>;
}

export async function fetchProfile(name: string): Promise<ShowdownProfile> {
  const userid = toUserId(name);
  if (!userid) throw new PsApiError('Enter a Showdown username.', 400);
  return cached(`profile:${userid}`, 5 * 60_000, async () => {
    const { status, text } = await fetchText(`https://pokemonshowdown.com/users/${userid}.json`);
    // Unknown users come back 404 with an empty profile body; registered users 200.
    if (status === 404) throw new PsApiError(`No Showdown account named "${name}".`, 404);
    if (status !== 200) throw new PsApiError(`Showdown profile lookup failed (HTTP ${status}).`, 502);
    const raw = parseJson<RawProfile>(text, 'profile');
    if (!raw.registertime) throw new PsApiError(`No registered Showdown account named "${name}".`, 404);

    const known = knownChampionsFormats();
    const ratings: FormatRating[] = Object.entries(raw.ratings ?? {})
      .filter(([format]) => isChampionsFormat(format))
      .map(([format, r]) => ({
        format,
        elo: Math.round(r.elo ?? 1000),
        gxe: Number(r.gxe ?? 0),
        w: r.w ?? 0,
        l: r.l ?? 0,
      }))
      .sort((a, b) => {
        const ia = known.indexOf(a.format);
        const ib = known.indexOf(b.format);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? known.length : ia) - (ib === -1 ? known.length : ib);
        return b.format.localeCompare(a.format);
      });

    return { name: raw.username || name, userid, ratings };
  });
}

// ─── Replays ──────────────────────────────────────────────────────────────────

interface RawReplay {
  id: string;
  format: string;
  players: string[];
  uploadtime: number;
  private?: number;
}

/**
 * Recent replays. With `format`, Showdown filters server-side; without it we take the first page
 * and keep only Champions formats.
 */
export async function fetchRecentReplays(name: string, format?: string): Promise<ShowdownReplay[]> {
  const userid = toUserId(name);
  if (!userid) throw new PsApiError('Enter a Showdown username.', 400);
  const fmt = format?.trim() || '';
  return cached(`replays:${userid}:${fmt}`, 5 * 60_000, async () => {
    const qs = new URLSearchParams({ user: userid });
    if (fmt) qs.set('format', fmt);
    const { status, text } = await fetchText(`https://replay.pokemonshowdown.com/search.json?${qs}`);
    if (status !== 200) throw new PsApiError(`Replay search failed (HTTP ${status}).`, 502);
    const raw = parseJson<RawReplay[]>(text, 'replays');
    if (!Array.isArray(raw)) throw new PsApiError('Replay search returned an unexpected shape.', 502);
    return raw
      .map((r) => ({
        id: r.id,
        format: r.format,
        formatId: r.id.replace(/^(smogtours-|test-)/, '').replace(/-\d+$/, ''),
        players: r.players ?? [],
        uploadtime: r.uploadtime,
        url: `https://replay.pokemonshowdown.com/${r.id}`,
      }))
      .filter((r) => (fmt ? true : isChampionsFormat(r.formatId)))
      .sort((a, b) => b.uploadtime - a.uploadtime);
  });
}

// ─── Public teams ─────────────────────────────────────────────────────────────

interface RawTeamSearch {
  result?: { teamid: number; ownerid: string; title?: string; format?: string; date?: string; private?: unknown }[];
}

/** The user's public teams from the Showdown teams DB. Without `format`, Champions formats only. */
export async function fetchPublicTeams(name: string, format?: string): Promise<ShowdownPublicTeam[]> {
  const userid = toUserId(name);
  if (!userid) throw new PsApiError('Enter a Showdown username.', 400);
  const fmt = format?.trim() || '';
  return cached(`teams:${userid}:${fmt}`, 5 * 60_000, async () => {
    const qs = new URLSearchParams({ owner: userid, count: '20' });
    if (fmt) qs.set('format', fmt);
    const { status, text } = await fetchText(`https://teams.pokemonshowdown.com/api/searchteams?${qs}`);
    if (status !== 200) throw new PsApiError(`Showdown teams search failed (HTTP ${status}).`, 502);
    const raw = parseJson<RawTeamSearch>(text, 'teams search');
    return (raw.result ?? [])
      .filter((t) => !t.private && (fmt ? true : isChampionsFormat(t.format ?? '')))
      .map((t) => ({
        teamid: t.teamid,
        title: t.title?.trim() || `Team ${t.teamid}`,
        format: t.format ?? '',
        date: t.date ?? '',
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  });
}

// ─── Single team paste ────────────────────────────────────────────────────────

/**
 * Accepts a bare id, `https://psim.us/t/<id>`, `https://psim.us/t/<id>-<password>`,
 * `https://play.pokemonshowdown.com/t/<id>[-<password>]`, or
 * `https://teams.pokemonshowdown.com/view/<id>[-<password>]`.
 */
export function parseTeamRef(ref: string): { teamid: string; password?: string } | null {
  const s = ref.trim();
  if (!s) return null;
  let m = s.match(/^(\d+)(?:-([A-Za-z0-9]+))?$/);
  if (m) return { teamid: m[1], password: m[2] };
  m = s.match(/(?:psim\.us|pokemonshowdown\.com)\/(?:t|view)\/(\d+)(?:-([A-Za-z0-9]+))?/i);
  if (m) return { teamid: m[1], password: m[2] };
  m = s.match(/getteam\?[^#]*teamid=(\d+)/i);
  if (m) {
    const pw = s.match(/[?&]password=([A-Za-z0-9]+)/i)?.[1];
    return { teamid: m[1], password: pw };
  }
  return null;
}

interface RawTeam {
  team?: string | null;
  title?: string;
  format?: string;
  ownerid?: string;
}

/** Showdown export text for a team, or a PsApiError if it is missing or private. */
export async function fetchShowdownTeamPaste(idOrUrl: string, password?: string): Promise<string> {
  const parsed = parseTeamRef(idOrUrl);
  if (!parsed) throw new PsApiError('That does not look like a Showdown team link or id.', 400);
  const pw = password?.trim() || parsed.password || '';
  const qs = new URLSearchParams({ teamid: parsed.teamid, full: '1', raw: '1' });
  if (pw) qs.set('password', pw);
  const { status, text } = await fetchText(`https://teams.pokemonshowdown.com/api/getteam?${qs}`);
  if (status === 404) throw new PsApiError(`Showdown team ${parsed.teamid} was not found.`, 404);
  if (status !== 200) throw new PsApiError(`Showdown team lookup failed (HTTP ${status}).`, 502);
  const raw = parseJson<RawTeam>(text, 'team');
  if (typeof raw.team !== 'string' || !raw.team.trim()) {
    throw new PsApiError(
      pw
        ? `Showdown team ${parsed.teamid} was not found, or the link's password is wrong.`
        : `Showdown team ${parsed.teamid} is private or does not exist. Use the full share link (psim.us/t/<id>-<password>).`,
      404,
    );
  }
  return raw.team.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
}

// ─── PokePaste ────────────────────────────────────────────────────────────────

export async function createPokePaste(input: { paste: string; title?: string; author?: string; notes?: string }): Promise<string> {
  const paste = input.paste?.trim();
  if (!paste) throw new PsApiError('Nothing to share: the paste is empty.', 400);
  const form = new URLSearchParams({
    paste,
    title: input.title?.trim() || '',
    author: input.author?.trim() || '',
    notes: input.notes?.trim() || '',
  });
  let res: Response;
  try {
    res = await fetch('https://pokepast.es/create', {
      method: 'POST',
      headers: { 'User-Agent': PS_USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    throw new PsApiError(`Could not reach pokepast.es: ${(e as Error).message}`, 502);
  }
  const location = res.headers.get('location');
  if ((res.status === 303 || res.status === 302 || res.status === 301) && location) {
    return location.startsWith('http') ? location : `https://pokepast.es${location.startsWith('/') ? '' : '/'}${location}`;
  }
  throw new PsApiError(`PokePaste did not return a paste URL (HTTP ${res.status}).`, 502);
}
