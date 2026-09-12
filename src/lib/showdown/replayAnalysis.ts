/**
 * Replay log analysis. Turns Showdown replay logs into deterministic facts about how a player
 * actually plays: what they brought out of their six, what they led, what they beat, what beat
 * them. No model is involved anywhere in this module — every number below is counted out of a
 * battle log, the same way the calc engine is the only source of damage numbers.
 *
 * Source: GET https://replay.pokemonshowdown.com/<id>.json → { id, format, formatid, players,
 * log, uploadtime, rating }. `log` is the Showdown battle protocol: newline-delimited,
 * `|`-prefixed messages. The lines this parser depends on:
 *
 *   |gametype|doubles                            must be doubles or the replay is skipped
 *   |player|p1|<name>|<avatar>|<rating>          side → display name
 *   |poke|p1|<Species, L50, F>|<item?>           team preview, one line per Pokémon
 *   |teampreview|4                               how many each side brings
 *   |start                                       leads are the switches between here and |turn|1
 *   |switch|p1a: <nick>|<Species, L50, F>|<hp>   entries; `drag` is the forced variant
 *   |detailschange|p1a: <nick>|<Species-Mega,…>  Mega/forme change, never a new team member
 *   |turn|<n>                                    turn counter
 *   |-fieldstart|move: Trick Room|[of] p1a: …    archetype markers
 *   |-sidestart|p1: <name>|move: Tailwind
 *   |-weather|SunnyDay|[from] ability: Drought|[of] p2b: …
 *   |win|<name>  /  |tie                         result
 *
 * Guarantees:
 *   - `parseReplayLog` is pure and deterministic: same log in, same facts out, no network.
 *   - Species are attributed by in-battle nickname, so a Pokémon that Megas mid-game still
 *     counts as the team-preview species it was brought as.
 *   - The protocol is not a contract. A log that yields no players, no preview, no leads, no
 *     turns or no result is treated as parser drift: `parseReplayLog` returns null and the
 *     aggregate *excludes* the replay and reports it, rather than counting a phantom 0-0 game.
 *   - `analyseUserReplays` only ever mixes one format id. A user's Singles or previous-regulation
 *     games never land in their Reg M-C numbers.
 *   - Serverless-safe: at most MAX_REPLAYS (25) replays per call, fetched with bounded
 *     concurrency, each upstream call capped at 10s, individual failures skipped rather than
 *     failing the batch. Parsed replays go through the tiered cache in `src/lib/cache/persistent.ts`
 *     under the DETERMINISTIC policy, keyed on the replay id: a replay is immutable once uploaded,
 *     so the parse is kept until the schema version moves, and with Firebase admin credentials it
 *     survives cold starts. Aggregates are recomputed from those parses every five minutes and are
 *     kept in-process only — they are keyed by a Showdown username, and the shared Firestore tier
 *     is for format-wide data, not for one person's games.
 *   - No Showdown password is ever requested, sent, or stored. Only public replays are readable.
 *
 * Server-only — never import into client code (replay.pokemonshowdown.com has no CORS for us).
 */

import { formatLabel, isChampionsFormat, PS_USER_AGENT, toUserId, fetchRecentReplays, PsApiError } from './psApi';
import { cached, DETERMINISTIC, MINUTE_MS } from '@/lib/cache/persistent';

const REPLAY_BASE = 'https://replay.pokemonshowdown.com';
/** Hard ceiling on upstream fetches per request, so one analysis fits in a serverless invocation. */
export const MAX_REPLAYS = 25;
const DEFAULT_REPLAYS = 25;
const CONCURRENCY = 5;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Aggregates are cheap once the replays behind them are parsed, so they are only briefly reused. */
const AGGREGATE_TTL_MS = 5 * MINUTE_MS;

/**
 * Schema version of `ParsedReplay` in the `replay` cache namespace. Entries never expire on their
 * own (a replay is immutable), so this number is the only thing that retires them: bump it when
 * `ParsedReplay` changes shape, when `parseReplayLog` reads a protocol line differently, and when a
 * parser fix should make previously "unparsable" replays be re-read — those nulls are cached too.
 */
const REPLAY_SCHEMA_VERSION = 1;

/**
 * Schema version of `ReplayAggregate` in the `replay-aggregate` namespace. Bump it when the
 * aggregate's shape changes or when any counting rule does (what counts as brought, how a lead pair
 * is keyed, which games enter a win rate's denominator).
 */
const AGGREGATE_SCHEMA_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlayerSlot = 'p1' | 'p2';

/** Archetype markers, all read off the same single pass over the log. */
export type ArchetypeMarker = 'trickRoom' | 'tailwind' | 'screens' | 'sun' | 'rain' | 'sand' | 'snow';

export const ARCHETYPE_MARKERS: ArchetypeMarker[] = ['trickRoom', 'tailwind', 'screens', 'sun', 'rain', 'sand', 'snow'];

export type MarkerSet = Record<ArchetypeMarker, boolean>;

export interface ReplaySide {
  slot: PlayerSlot;
  /** Display name as the log reports it. */
  player: string;
  userid: string;
  /** The full six from team preview, in preview order. Empty only on a log without preview. */
  team: string[];
  /** Species actually sent out, in order of first appearance. Normally four in VGC. */
  brought: string[];
  /** The pair that entered at `|start`, ordered by battle position (a then b). */
  lead: string[];
  /** Which archetype markers this side put up during the game. */
  markers: MarkerSet;
}

export interface ParsedReplay {
  id: string;
  url: string;
  /** Format id, e.g. gen9championsvgc2026regmc. */
  formatId: string;
  /** Human label, e.g. "VGC 2026 Reg M-C". */
  format: string;
  uploadtime: number;
  /** Showdown's reported ladder rating for the battle, when it was rated. */
  rating: number | null;
  /** Number of turns played (the highest `|turn|` seen). */
  turns: number;
  /** Winner's display name; null when the battle was a tie. */
  winner: string | null;
  tie: boolean;
  p1: ReplaySide;
  p2: ReplaySide;
}

export type ExclusionReason =
  /** The replay JSON could not be fetched, or came back without a log. */
  | 'fetch-failed'
  /** Fetched fine, but the log did not yield the facts this parser needs (protocol drift). */
  | 'unparsable'
  /** Not the format being analysed. */
  | 'wrong-format'
  /** Neither side is the requested user. */
  | 'player-not-found';

export interface ExcludedReplay {
  id: string;
  reason: ExclusionReason;
}

export interface BringRate {
  species: string;
  /** Games where this species was on the user's team-preview six. */
  available: number;
  /** Games where it was one of the four brought. */
  brought: number;
  /** brought / available, 0–1, three decimals. */
  rate: number;
}

export interface LeadPairStat {
  /** The two species, sorted alphabetically so A+B and B+A are one row. */
  lead: string[];
  label: string;
  games: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses), 0–1, three decimals. Ties are excluded from the denominator. */
  winRate: number;
}

export interface WinLossRecord {
  games: number;
  wins: number;
  losses: number;
  ties: number;
  /** wins / (wins + losses), 0–1, three decimals. */
  winRate: number;
}

export interface MarkerSplit extends WinLossRecord {
  marker: ArchetypeMarker;
}

export interface FacedSpecies {
  species: string;
  /** Games where the opponent brought it. */
  faced: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface ReplayAggregate {
  /** Display name as Showdown reports it in the analysed logs, falling back to the request. */
  user: string;
  userid: string;
  /** The one format id every counted game is from. */
  formatId: string;
  format: string;
  /** Replays matching the format that were candidates before fetching. */
  candidates: number;
  /** Replays actually fetched (candidates capped at the limit). */
  requested: number;
  /** Replays that produced usable facts and are counted below. */
  analysed: number;
  excluded: ExcludedReplay[];
  record: WinLossRecord;
  bringRates: BringRate[];
  leads: LeadPairStat[];
  /** Record in games where the *opponent* put up each marker. Only markers actually seen. */
  vsOpponentMarker: MarkerSplit[];
  /** Record in games where *you* put up each marker. Only markers actually seen. */
  withOwnMarker: MarkerSplit[];
  mostFaced: FacedSpecies[];
  /** Newest first; a slim per-game trail so a caller can show its work. */
  games: GameSummary[];
}

export interface GameSummary {
  id: string;
  url: string;
  uploadtime: number;
  rating: number | null;
  turns: number;
  result: 'win' | 'loss' | 'tie';
  opponent: string;
  yourLead: string[];
  yourBrought: string[];
  opponentLead: string[];
  opponentBrought: string[];
  opponentMarkers: ArchetypeMarker[];
}

// ─── Log parsing ──────────────────────────────────────────────────────────────

function emptyMarkers(): MarkerSet {
  return { trickRoom: false, tailwind: false, screens: false, sun: false, rain: false, sand: false, snow: false };
}

/** Species out of a details string like "Charizard-Mega-Y, L50, F, shiny". */
function speciesOf(details: string): string {
  return (details.split(',')[0] ?? '').trim();
}

/** Position + nickname out of "p1a: Biscuit" → { slot: 'p1', nick: 'Biscuit', pos: 'p1a' }. */
function identOf(ident: string): { slot: PlayerSlot; pos: string; nick: string } | null {
  const m = ident.match(/^(p[12])([a-z]?):\s*(.*)$/);
  if (!m) return null;
  return { slot: m[1] as PlayerSlot, pos: m[1] + m[2], nick: m[3].trim() };
}

const SCREEN_MOVES = new Set(['Reflect', 'Light Screen', 'Aurora Veil']);
const WEATHER_MARKER: Record<string, ArchetypeMarker> = {
  SunnyDay: 'sun',
  DesolateLand: 'sun',
  RainDance: 'rain',
  PrimordialSea: 'rain',
  Sandstorm: 'sand',
  Snow: 'snow',
  Snowscape: 'snow',
  Hail: 'snow',
};

/** The `[of] p1a: X` tag some messages carry, as a slot. */
function slotFromTags(parts: string[]): PlayerSlot | null {
  for (const p of parts) {
    if (p.startsWith('[of] ')) return identOf(p.slice(5))?.slot ?? null;
  }
  return null;
}

/**
 * Resolve an in-battle species to the team-preview entry it belongs to. Primary path is the
 * nickname, which is stable across Mega Evolution and forme changes; the hyphen-prefix fallback
 * covers a Pokémon whose first sighting is already transformed.
 */
function resolveToPreview(species: string, team: string[]): string {
  if (team.includes(species)) return species;
  const base = species.split('-')[0];
  const matches = team.filter((t) => t.split('-')[0] === base);
  return matches.length === 1 ? matches[0] : species;
}

export interface RawReplay {
  id?: string;
  format?: string;
  formatid?: string;
  players?: string[];
  log?: string;
  uploadtime?: number;
  rating?: number | null;
}

/**
 * Parse one replay into structured facts. Pure and deterministic; no network, no clock.
 * Returns null when the log does not yield the facts we need — treat that as parser drift and
 * drop the replay rather than counting an empty game.
 */
export function parseReplayLog(raw: RawReplay): ParsedReplay | null {
  const log = raw.log;
  if (typeof log !== 'string' || !log.includes('|')) return null;

  const id = (raw.id ?? '').trim();
  const formatId = (raw.formatid ?? '').trim() || id.replace(/^(smogtours-|test-)/, '').replace(/-\d+$/, '');

  const names: Record<PlayerSlot, string> = { p1: '', p2: '' };
  const teams: Record<PlayerSlot, string[]> = { p1: [], p2: [] };
  const brought: Record<PlayerSlot, string[]> = { p1: [], p2: [] };
  const leads: Record<PlayerSlot, { pos: string; species: string }[]> = { p1: [], p2: [] };
  const markers: Record<PlayerSlot, MarkerSet> = { p1: emptyMarkers(), p2: emptyMarkers() };
  /** nickname → team-preview species, per side. */
  const nicks: Record<PlayerSlot, Map<string, string>> = { p1: new Map(), p2: new Map() };

  let gametype = '';
  let turns = 0;
  let winner: string | null = null;
  let tie = false;
  let started = false;
  let inLeadWindow = false;
  /** Whose move is currently resolving, for messages that carry no `[of]` tag. */
  let lastMover: PlayerSlot | null = null;

  const note = (slot: PlayerSlot | null, marker: ArchetypeMarker) => {
    if (slot) markers[slot][marker] = true;
  };

  for (const line of log.split('\n')) {
    if (line.charCodeAt(0) !== 124 /* | */) continue;
    const parts = line.split('|');
    const kind = parts[1];

    switch (kind) {
      case 'gametype':
        gametype = (parts[2] ?? '').trim();
        break;

      case 'player': {
        const slot = parts[2] as PlayerSlot;
        const name = (parts[3] ?? '').trim();
        // `|player|p1|` with no name is a leave event, not a rename.
        if ((slot === 'p1' || slot === 'p2') && name) names[slot] = name;
        break;
      }

      case 'poke': {
        const slot = parts[2] as PlayerSlot;
        const species = speciesOf(parts[3] ?? '');
        if ((slot === 'p1' || slot === 'p2') && species) teams[slot].push(species);
        break;
      }

      case 'start':
        started = true;
        inLeadWindow = true;
        break;

      case 'turn': {
        const n = Number(parts[2]);
        if (Number.isFinite(n) && n > turns) turns = n;
        inLeadWindow = false;
        lastMover = null;
        break;
      }

      case 'switch':
      case 'drag': {
        const ident = identOf(parts[2] ?? '');
        const species = speciesOf(parts[3] ?? '');
        if (!ident || !species) break;
        const { slot, pos, nick } = ident;
        let resolved = nicks[slot].get(nick);
        if (!resolved) {
          resolved = resolveToPreview(species, teams[slot]);
          nicks[slot].set(nick, resolved);
        }
        if (!brought[slot].includes(resolved)) brought[slot].push(resolved);
        if (started && inLeadWindow && !leads[slot].some((l) => l.pos === pos)) {
          leads[slot].push({ pos, species: resolved });
        }
        break;
      }

      case 'move': {
        const ident = identOf(parts[2] ?? '');
        if (ident) lastMover = ident.slot;
        break;
      }

      case '-sidestart': {
        const slot = identOf(parts[2] ?? '')?.slot ?? null;
        const move = (parts[3] ?? '').replace(/^move:\s*/, '').trim();
        if (move === 'Tailwind') note(slot, 'tailwind');
        else if (SCREEN_MOVES.has(move)) note(slot, 'screens');
        break;
      }

      case '-fieldstart': {
        const move = (parts[2] ?? '').replace(/^move:\s*/, '').trim();
        if (move === 'Trick Room') note(slotFromTags(parts) ?? lastMover, 'trickRoom');
        break;
      }

      case '-weather': {
        const weather = (parts[2] ?? '').trim();
        // `[upkeep]` is the per-turn residual message, not a set.
        if (parts.includes('[upkeep]')) break;
        const marker = WEATHER_MARKER[weather];
        if (marker) note(slotFromTags(parts) ?? lastMover, marker);
        break;
      }

      case 'win':
        winner = (parts[2] ?? '').trim() || null;
        break;

      case 'tie':
        tie = true;
        break;

      default:
        break;
    }
  }

  // Drift gate: anything missing here means the log is not the protocol we parse.
  if (!names.p1 || !names.p2) return null;
  if (gametype !== 'doubles') return null;
  if (teams.p1.length === 0 || teams.p2.length === 0) return null;
  if (leads.p1.length === 0 || leads.p2.length === 0) return null;
  if (turns < 1) return null;
  if (!winner && !tie) return null;

  const side = (slot: PlayerSlot): ReplaySide => ({
    slot,
    player: names[slot],
    userid: toUserId(names[slot]),
    team: teams[slot],
    brought: brought[slot],
    lead: leads[slot].sort((a, b) => a.pos.localeCompare(b.pos)).map((l) => l.species),
    markers: markers[slot],
  });

  return {
    id,
    url: `${REPLAY_BASE}/${id}`,
    formatId,
    format: formatLabel(formatId),
    uploadtime: raw.uploadtime ?? 0,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    turns,
    winner: tie ? null : winner,
    tie,
    p1: side('p1'),
    p2: side('p2'),
  };
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

/** Sentinel for a fetch that never reached a log. Thrown so the cache stores nothing for it. */
class ReplayFetchFailed extends Error {}

/**
 * Fetch and parse one replay. Never throws: a network failure, a non-200, a missing log or a
 * log this parser cannot read all come back as a reason instead.
 *
 * Parse outcomes are cached under DETERMINISTIC, keyed on the replay id — a replay's log never
 * changes once uploaded, so the same id can only ever parse to the same facts. "Unparsable" (null)
 * is a real outcome and is cached with the rest; `REPLAY_SCHEMA_VERSION` is what re-reads those
 * after a parser fix. Fetch failures are the exception: the loader throws, so nothing is stored and
 * a blip is retried on the next call, exactly as before.
 */
export async function fetchReplay(id: string): Promise<{ replay: ParsedReplay } | { failed: ExclusionReason }> {
  let replay: ParsedReplay | null;
  try {
    replay = await cached<ParsedReplay | null>(
      'replay',
      id,
      { ...DETERMINISTIC, version: REPLAY_SCHEMA_VERSION },
      async () => {
        let raw: RawReplay;
        try {
          const res = await fetch(`${REPLAY_BASE}/${encodeURIComponent(id)}.json`, {
            headers: { 'User-Agent': PS_USER_AGENT, Accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (!res.ok) throw new ReplayFetchFailed();
          const text = await res.text();
          raw = JSON.parse(text.replace(/^\s*\]/, '')) as RawReplay;
        } catch {
          throw new ReplayFetchFailed();
        }
        if (typeof raw?.log !== 'string' || !raw.log) throw new ReplayFetchFailed();
        return parseReplayLog({ ...raw, id: raw.id || id });
      },
    );
  } catch {
    return { failed: 'fetch-failed' };
  }
  return replay ? { replay } : { failed: 'unparsable' };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the output. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

function ratio(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
}

function emptyRecord(): { games: number; wins: number; losses: number; ties: number } {
  return { games: 0, wins: 0, losses: 0, ties: 0 };
}

function sealRecord(r: { games: number; wins: number; losses: number; ties: number }): WinLossRecord {
  return { ...r, winRate: ratio(r.wins, r.wins + r.losses) };
}

export interface AnalyseOptions {
  user: string;
  /** Champions format id. Defaults to the format of the user's most recent Champions replay. */
  formatId?: string;
  /** Replays to analyse, clamped to 1…MAX_REPLAYS. */
  limit?: number;
}

/**
 * Aggregate a user's recent replays in one format into bring rates, lead pairs, record and
 * matchup splits. Throws PsApiError only when the *search* fails or the user has no replays in
 * the format; individual replay failures are reported in `excluded`, never thrown.
 *
 * Held for five minutes so a panel that re-renders does not re-walk the replay list, and `l1Only`
 * so this never reaches the shared Firestore tier: the key is a Showdown username, and that cache
 * is for format-wide data. A PsApiError propagates and is never cached.
 */
export async function analyseUserReplays(opts: AnalyseOptions): Promise<ReplayAggregate> {
  const userid = toUserId(opts.user);
  if (!userid) throw new PsApiError('Enter a Showdown username.', 400);
  const limit = Math.min(MAX_REPLAYS, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_REPLAYS)));

  const requestedFormat = opts.formatId?.trim() || '';
  if (requestedFormat && !isChampionsFormat(requestedFormat)) {
    throw new PsApiError(`${requestedFormat} is not a Champions format; replay analysis is VGC-only.`, 400);
  }

  // Keyed on the format as *asked for*: resolving an empty one to the user's newest Champions
  // format is part of the work being cached.
  return cached(
    'replay-aggregate',
    `${userid}:${requestedFormat}:${limit}`,
    { version: AGGREGATE_SCHEMA_VERSION, ttlMs: AGGREGATE_TTL_MS, l1Only: true },
    () => buildAggregate(opts, userid, requestedFormat, limit),
  );
}

async function buildAggregate(
  opts: AnalyseOptions,
  userid: string,
  requestedFormat: string,
  limit: number,
): Promise<ReplayAggregate> {
  let formatId = requestedFormat;
  // Champions-only, newest first. Without an explicit format, lock onto the newest one present so
  // a user's Reg M-B and Reg M-C games are never blended into one set of numbers.
  const all = await fetchRecentReplays(opts.user, formatId || undefined);
  if (!formatId) {
    formatId = all.find((r) => isChampionsFormat(r.formatId))?.formatId ?? '';
    if (!formatId) throw new PsApiError(`No Champions replays found for "${opts.user}".`, 404);
  }
  const candidates = all.filter((r) => r.formatId === formatId);
  if (candidates.length === 0) {
    throw new PsApiError(`No ${formatLabel(formatId)} replays found for "${opts.user}".`, 404);
  }
  const chosen = candidates.slice(0, limit);

  const loaded = await mapWithConcurrency(chosen, CONCURRENCY, (r) => fetchReplay(r.id));

  const excluded: ExcludedReplay[] = [];
  const record = emptyRecord();
  const available = new Map<string, number>();
  const broughtCount = new Map<string, number>();
  const leadStats = new Map<string, { lead: string[]; games: number; wins: number; losses: number }>();
  const facedStats = new Map<string, { faced: number; wins: number; losses: number }>();
  const vsMarker = new Map<ArchetypeMarker, ReturnType<typeof emptyRecord>>();
  const ownMarker = new Map<ArchetypeMarker, ReturnType<typeof emptyRecord>>();
  const games: GameSummary[] = [];
  let displayName = '';

  for (let i = 0; i < chosen.length; i++) {
    const meta = chosen[i];
    const result = loaded[i];
    if ('failed' in result) {
      excluded.push({ id: meta.id, reason: result.failed });
      continue;
    }
    const replay = result.replay;
    if (replay.formatId !== formatId) {
      excluded.push({ id: meta.id, reason: 'wrong-format' });
      continue;
    }
    const me = replay.p1.userid === userid ? replay.p1 : replay.p2.userid === userid ? replay.p2 : null;
    if (!me) {
      excluded.push({ id: meta.id, reason: 'player-not-found' });
      continue;
    }
    const them = me.slot === 'p1' ? replay.p2 : replay.p1;
    if (!displayName) displayName = me.player;

    const outcome: 'win' | 'loss' | 'tie' = replay.tie ? 'tie' : replay.winner === me.player ? 'win' : 'loss';
    record.games++;
    if (outcome === 'win') record.wins++;
    else if (outcome === 'loss') record.losses++;
    else record.ties++;

    for (const species of new Set(me.team)) available.set(species, (available.get(species) ?? 0) + 1);
    for (const species of new Set(me.brought)) broughtCount.set(species, (broughtCount.get(species) ?? 0) + 1);

    if (me.lead.length >= 2) {
      const pair = [...me.lead].sort((a, b) => a.localeCompare(b));
      const key = pair.join(' + ');
      const row = leadStats.get(key) ?? { lead: pair, games: 0, wins: 0, losses: 0 };
      row.games++;
      if (outcome === 'win') row.wins++;
      else if (outcome === 'loss') row.losses++;
      leadStats.set(key, row);
    }

    for (const species of new Set(them.brought)) {
      const row = facedStats.get(species) ?? { faced: 0, wins: 0, losses: 0 };
      row.faced++;
      if (outcome === 'win') row.wins++;
      else if (outcome === 'loss') row.losses++;
      facedStats.set(species, row);
    }

    for (const marker of ARCHETYPE_MARKERS) {
      if (them.markers[marker]) {
        const row = vsMarker.get(marker) ?? emptyRecord();
        row.games++;
        if (outcome === 'win') row.wins++;
        else if (outcome === 'loss') row.losses++;
        else row.ties++;
        vsMarker.set(marker, row);
      }
      if (me.markers[marker]) {
        const row = ownMarker.get(marker) ?? emptyRecord();
        row.games++;
        if (outcome === 'win') row.wins++;
        else if (outcome === 'loss') row.losses++;
        else row.ties++;
        ownMarker.set(marker, row);
      }
    }

    games.push({
      id: replay.id,
      url: replay.url,
      uploadtime: replay.uploadtime,
      rating: replay.rating,
      turns: replay.turns,
      result: outcome,
      opponent: them.player,
      yourLead: me.lead,
      yourBrought: me.brought,
      opponentLead: them.lead,
      opponentBrought: them.brought,
      opponentMarkers: ARCHETYPE_MARKERS.filter((m) => them.markers[m]),
    });
  }

  const bringRates: BringRate[] = [...available.entries()]
    .map(([species, avail]) => ({
      species,
      available: avail,
      brought: broughtCount.get(species) ?? 0,
      rate: ratio(broughtCount.get(species) ?? 0, avail),
    }))
    // Absolute count first: a species brought once out of one game is not a 100% staple.
    .sort((a, b) => b.brought - a.brought || b.rate - a.rate || b.available - a.available || a.species.localeCompare(b.species));

  const leads: LeadPairStat[] = [...leadStats.entries()]
    .map(([label, r]) => ({ lead: r.lead, label, games: r.games, wins: r.wins, losses: r.losses, winRate: ratio(r.wins, r.wins + r.losses) }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate || a.label.localeCompare(b.label));

  const splits = (m: Map<ArchetypeMarker, ReturnType<typeof emptyRecord>>): MarkerSplit[] =>
    ARCHETYPE_MARKERS.filter((k) => m.has(k))
      .map((k) => ({ marker: k, ...sealRecord(m.get(k)!) }))
      .sort((a, b) => b.games - a.games);

  const mostFaced: FacedSpecies[] = [...facedStats.entries()]
    .map(([species, r]) => ({ species, faced: r.faced, wins: r.wins, losses: r.losses, winRate: ratio(r.wins, r.wins + r.losses) }))
    .sort((a, b) => b.faced - a.faced || a.species.localeCompare(b.species));

  const aggregate: ReplayAggregate = {
    user: displayName || opts.user,
    userid,
    formatId,
    format: formatLabel(formatId),
    candidates: candidates.length,
    requested: chosen.length,
    analysed: record.games,
    excluded,
    record: sealRecord(record),
    bringRates,
    leads,
    vsOpponentMarker: splits(vsMarker),
    withOwnMarker: splits(ownMarker),
    mostFaced,
    games: games.sort((a, b) => b.uploadtime - a.uploadtime),
  };

  return aggregate;
}
