/**
 * Live usage stats from the Pikalytics AI endpoint.
 *
 * Endpoint: GET https://www.pikalytics.com/ai/pokedex/{format}/{pokemon}
 * Format: chosen per ruleset (src/lib/rulesets → pikalyticsFormats, tried in order). A regulation
 * Pikalytics has not published yet falls back to its predecessor; `resolveUsageFormat` reports
 * when that happens so the UI and the model can label the numbers honestly.
 * Response: text/markdown, refreshed monthly or on major events.
 *
 * Parsed out of each species page: headline usage/win rate/record, common moves, items, abilities
 * and teammates, the defensive type-matchup chart, the FAQ's top spread, and up to 10 featured
 * tournament teams (the focal Pokémon's set plus the full six-Pokémon composition it came from).
 *
 * The FAQ's top spread is the one field Pikalytics leaves empty on a newly launched regulation
 * ("No EV spread or nature data available") and under Mega/forme names. fetchUsage falls back to
 * the base species and then to the ruleset's older formats for that field only, and records where
 * a borrowed spread came from in `topSpreadSource` so callers can label it honestly.
 *
 * The markdown layout is not a contract — if Pikalytics changes it, the regex parsers stop matching.
 * Every section parser is independently defensive: a section that is missing, empty, or reshaped
 * yields an empty list or undefined rather than throwing. fetchUsage treats "fetched a real page but
 * parsed nothing" as a parser-drift failure and returns null rather than serving empty lists as if
 * they were real usage data.
 *
 * Caching: both fetches go through the tiered cache in `src/lib/cache/persistent.ts` under the
 * LIVE_DATA policy — fresh for 6h, then served stale for up to another 18h while one background
 * refresh runs, so no request ever waits on Pikalytics twice and the numbers are never more than a
 * day behind. With FIREBASE_ADMIN_* set the entries also survive a cold start and are shared across
 * instances; without it the cache is in-process only, as it always was. A null (404, a format
 * Pikalytics has not published, a page that parsed to nothing) is cached as a negative for five
 * minutes only, so a newly published regulation and a fixed parser both show up without a restart.
 * A transport failure is not cached at all: it falls out of the cache as an error, is turned back
 * into null here, and is retried on the next call.
 *
 * Server-only — never import into client code.
 */

import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import { cached, LIVE_DATA } from '@/lib/cache/persistent';

const BASE = 'https://www.pikalytics.com/ai/pokedex';
const HEADERS = { 'User-Agent': 'VGC-Champions-Tool/1.0' };

/**
 * Schema version of the parsed `UsageData` in the `usage` cache namespace. A cached entry is
 * handed back to newly typed code on the strength of this number alone, so bump it whenever
 * `UsageData` (or what `parseMarkdown` puts in it) changes shape — a new field, a field that
 * changes meaning, a parser fix that makes an existing field come out differently.
 *
 * 2: teammates, typeMatchups, topSpreadSource, and PopularSet.members/event were added.
 */
const USAGE_SCHEMA_VERSION = 2;

/**
 * Schema version of the `usage-format` namespace, which holds a format landing page's raw
 * markdown. Bump it when what is stored changes — if this ever caches parsed rankings instead of
 * the markdown, or if `fetchFormatPage`'s "is this a real page" test changes what counts as one.
 * Not bumped for `parseRankings` changes: the markdown is re-parsed on every read.
 */
const FORMAT_PAGE_SCHEMA_VERSION = 1;
// Pikalytics occasionally stalls; a hung fetch inside a serverless request would run into the
// platform's function timeout and surface as a raw error page, so every upstream call is capped.
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Fetch a format's landing page (rankings); null when Pikalytics has no data for it.
 *
 * Cached under LIVE_DATA. A null — an unpublished format, a 200 "Format Not Found" stub, a page
 * whose rankings table no longer parses, or an upstream failure — is a negative and lives for five
 * minutes only, which is the re-probe interval this function has always had, so a newly released
 * regulation's data shows up without a restart.
 */
async function fetchFormatPage(format: string): Promise<string | null> {
  return cached(
    'usage-format',
    format,
    { ...LIVE_DATA, version: FORMAT_PAGE_SCHEMA_VERSION },
    async () => {
      try {
        const res = await fetch(`${BASE}/${format}`, { headers: HEADERS, next: { revalidate: 3600 }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        if (!res.ok) return null;
        const text = await res.text();
        // "# Format Not Found" is a 200 with a stub body; a real page has a rankings table.
        if (/^#\s*Format Not Found/i.test(text.trim()) || parseRankings(text).length === 0) return null;
        return text;
      } catch {
        return null;
      }
    },
  );
}

export interface UsageFormatResolution {
  /** Pikalytics format code actually serving data. */
  format: string;
  /** The ruleset's preferred format when a fallback is serving instead; null when data is native. */
  fallbackFrom: string | null;
}

/** Pick the first of the ruleset's formats that Pikalytics actually has data for. */
export async function resolveUsageFormat(ruleset: RulesetId = DEFAULT_RULESET): Promise<UsageFormatResolution> {
  const formats = getRuleset(ruleset).pikalyticsFormats;
  for (const f of formats) {
    if (await fetchFormatPage(f)) return { format: f, fallbackFrom: f === formats[0] ? null : formats[0] };
  }
  return { format: formats[0], fallbackFrom: null };
}

export interface UsageEntry {
  name: string;
  pct: number;
}

export interface PopularSet {
  label: string;
  ability: string;
  item: string;
  moves: string[];
  nature?: string;
  sp?: Record<string, number>;
  /** The full six-Pokémon team this set was played on, focal species included. Empty when the page omits it. */
  members: string[];
  /** Tournament the team is from, as Pikalytics ids it, e.g. "limitless-6aa1288fa4272c53be64b8e7". */
  event?: string;
}

/** One attacking type and what it does to this species, as Pikalytics prints it. */
export interface TypeMatchup {
  /** Attacking type, e.g. "Ice". */
  type: string;
  /** Damage multiplier: 4, 2, 0.5, 0.25, or 0. */
  multiplier: number;
}

export interface TypeMatchups {
  weakTo: TypeMatchup[];
  resists: TypeMatchup[];
  immuneTo: TypeMatchup[];
  /** Pikalytics' caveat when an ability rewrites the chart, e.g. Levitate negating Ground. */
  abilityNote?: string;
}

export interface UsageData {
  species: string;
  usagePct: number;
  /** Ranked win rate — often present when usage % is N/A. */
  winRatePct?: number;
  /** W-L(-T) of the ranked sample, e.g. "14863-14069-23" or "1541-1406" — the evidence size behind the win rate. */
  record?: string;
  moves: UsageEntry[];
  items: UsageEntry[];
  abilities: UsageEntry[];
  /** Co-occurrence: how often each other species shares a team with this one. Direct synergy evidence. */
  teammates: UsageEntry[];
  sets: PopularSet[];
  topSpread?: Record<string, number>;
  /**
   * Pikalytics format the spread was borrowed from, set only when it is not the format serving the
   * rest of this data (a regulation too new to have spreads computed). Undefined means the spread
   * was measured in this format — label a borrowed one as the previous regulation's.
   */
  topSpreadSource?: string;
  /** Type chart for this species; undefined when the page has no matchup table. */
  typeMatchups?: TypeMatchups;
}

/**
 * Fetch and parse one species page under one format. Best-effort: any failure is null, never a
 * throw, because every caller is a fallback path filling in a field the primary page lacked.
 */
async function fetchParsed(format: string, species: string): Promise<UsageData | null> {
  try {
    const res = await fetch(`${BASE}/${format}/${encodeURIComponent(species)}`, {
      headers: HEADERS,
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseMarkdown(await res.text(), species);
  } catch {
    return null;
  }
}

/**
 * Load and parse one species page, plus the spread-only fallbacks. The loader behind the cache.
 *
 * Returns null for the two outcomes worth remembering briefly — a 404, and a page that fetched but
 * parsed to nothing — and *throws* for a transport failure, which the caller turns back into null
 * without caching it. That split is what keeps a network blip from being remembered for minutes.
 */
async function loadUsage(format: string, species: string, ruleset: RulesetId): Promise<UsageData | null> {
  const url = `${BASE}/${format}/${encodeURIComponent(species)}`;
  const res = await fetch(url, {
    headers: HEADERS,
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const md = await res.text();
  let data = parseMarkdown(md, species);
  // Parser-drift guard: a substantive page that yields no moves, items, abilities, sets, or usage
  // means the markdown format changed (or the page is an error shell) — serve null, and let the
  // cache hold it only as a five-minute negative so a parser fix is picked up without a restart.
  if (
    md.length > 200 &&
    !data.moves.length && !data.items.length && !data.abilities.length &&
    !data.sets.length && data.usagePct === 0
  ) {
    return null;
  }
  // Spread-only fallbacks, in order, and only when this page carried no spread of its own:
  // Pikalytics files spread data under the base species for Megas/formes, and a regulation that
  // launched days ago answers the spread FAQ with "No EV spread or nature data available" while
  // its predecessor format still serves one. Current format first, then the predecessor, so a
  // measured spread always beats a borrowed one. At most three extra best-effort fetches.
  if (!data.topSpread) {
    const base = species.replace(/-Mega(?:-[XYZ])?$/i, '').replace(/-Eternal$/, '');
    const formats = getRuleset(ruleset).pikalyticsFormats;
    // Formats are listed most specific first, so anything after the one serving data is older.
    // Only the next one back is tried, to keep the fetch count bounded.
    const idx = formats.indexOf(format);
    const older = idx >= 0 ? formats[idx + 1] : undefined;
    const attempts = [
      ...(base !== species ? [{ format, species: base }] : []),
      ...(older ? [{ format: older, species }] : []),
      ...(older && base !== species ? [{ format: older, species: base }] : []),
    ];
    for (const attempt of attempts) {
      const alt = await fetchParsed(attempt.format, attempt.species);
      if (!alt?.topSpread) continue;
      data = {
        ...data,
        topSpread: alt.topSpread,
        ...(attempt.format !== format ? { topSpreadSource: attempt.format } : {}),
      };
      break;
    }
  }
  return data;
}

/**
 * Usage for one species under the format currently serving this ruleset.
 *
 * Keyed by format *and* species, so a fallback format's numbers can never be served as the
 * preferred format's once Pikalytics publishes it. Never throws: every failure is null.
 */
export async function fetchUsage(species: string, ruleset: RulesetId = DEFAULT_RULESET): Promise<UsageData | null> {
  const { format } = await resolveUsageFormat(ruleset);
  try {
    return await cached(
      'usage',
      `${format}:${species.toLowerCase()}`,
      { ...LIVE_DATA, version: USAGE_SCHEMA_VERSION },
      () => loadUsage(format, species, ruleset),
    );
  } catch {
    // Transport failure with no stale entry to fall back on. Nothing was cached; retry next call.
    return null;
  }
}

/** Fetch top-N Pokémon usage rankings for the format. */
export interface UsageRank {
  rank: number;
  species: string;
  /** null when Pikalytics reports usage as N/A (win rate is the signal instead). */
  usagePct: number | null;
  winRatePct?: number;
  record?: string;
}

export async function fetchFormatRankings(ruleset: RulesetId = DEFAULT_RULESET): Promise<UsageRank[]> {
  const { format } = await resolveUsageFormat(ruleset);
  const md = await fetchFormatPage(format);
  return md ? parseRankings(md) : [];
}

// ---- markdown parsers ----

const STAT_ALIASES: Record<string, string> = {
  hp: 'hp', atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe',
};
const SP_MAX = 32;

function parseSetStatLine(line: string): Record<string, number> | undefined {
  const raw: Record<string, number> = {};
  for (const part of line.split('/')) {
    const m = part.trim().match(/^(\d+)\s+([A-Za-z]+)$/);
    if (!m) continue;
    const stat = STAT_ALIASES[m[2].toLowerCase()];
    if (stat) raw[stat] = Number(m[1]);
  }
  if (!Object.keys(raw).length) return undefined;
  const isEv = Object.values(raw).some((v) => v > SP_MAX);
  const sp: Record<string, number> = {};
  for (const [stat, v] of Object.entries(raw)) {
    sp[stat] = Math.min(SP_MAX, Math.max(0, isEv ? Math.round(v / 8) : v));
  }
  return sp;
}

function parseBulletTable(section: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of section.split('\n')) {
    // "- **Name**: 90.794%"
    const m = line.match(/\*\*(.+?)\*\*[:\s]+([0-9.]+)%/);
    if (m) entries.push({ name: m[1].trim(), pct: parseFloat(m[2]) });
  }
  return entries;
}

/** "Ice (4x), Dragon (2x)" → typed entries. "None", blanks, and unparseable cells yield nothing. */
function parseMatchupCell(cell: string): TypeMatchup[] {
  const out: TypeMatchup[] = [];
  for (const part of cell.split(',')) {
    // "Ice (4x)", "Fire (1/2x)", "Grass (1/4x)", "Electric (0x)"
    const m = part.trim().match(/^([A-Za-z][A-Za-z-]*)\s*\(\s*([\d.]+)(?:\s*\/\s*([\d.]+))?\s*x\s*\)$/);
    if (!m) continue;
    const num = parseFloat(m[2]);
    const den = m[3] ? parseFloat(m[3]) : 1;
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) continue;
    out.push({ type: m[1], multiplier: num / den });
  }
  return out;
}

/** Parse the "Defensive Type Matchups" table; undefined when the section is absent or unreadable. */
function parseTypeMatchups(md: string): TypeMatchups | undefined {
  const section = sliceSection(md, 'Defensive Type Matchups');
  if (!section) return undefined;
  // "| **Weak To** | Ice (4x), Dragon (2x), Fairy (2x) |"
  const cell = (label: string) => section.match(new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|([^|]*)\\|`))?.[1] ?? '';
  const weakTo = parseMatchupCell(cell('Weak To'));
  const resists = parseMatchupCell(cell('Resists'));
  const immuneTo = parseMatchupCell(cell('Immune To'));
  // "**Ability Notes**: Levitate: Ground moves become 0x unless Gravity…" — present only for some species.
  const abilityNote = section.match(/\*\*Ability Notes\*\*[:\s]+(.+)/)?.[1].trim();
  if (!weakTo.length && !resists.length && !immuneTo.length && !abilityNote) return undefined;
  return { weakTo, resists, immuneTo, ...(abilityNote ? { abilityNote } : {}) };
}

function sliceSection(md: string, heading: string): string {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  return md.match(re)?.[1] ?? '';
}

function parseMarkdown(md: string, species: string): UsageData {
  // Usage from quick-info table row: "| **Usage** | 41% |" (often "N/A" — win rate carries the signal)
  const usageMatch = md.match(/\*\*Usage\*\*\s*\|\s*([0-9.]+)%/);
  const usagePct = usageMatch ? parseFloat(usageMatch[1]) : 0;
  const winMatch = md.match(/\*\*Win Rate\*\*\s*\|\s*([0-9.]+)%/);
  const winRatePct = winMatch ? parseFloat(winMatch[1]) : undefined;
  const recordMatch = md.match(/\*\*Record\*\*\s*\|\s*(\d+-\d+(?:-\d+)?)/);
  const record = recordMatch?.[1];

  const moves = parseBulletTable(sliceSection(md, 'Common Moves'));
  const items = parseBulletTable(sliceSection(md, 'Common Items'));
  const abilities = parseBulletTable(sliceSection(md, 'Common Abilities'));
  const teammates = parseBulletTable(sliceSection(md, 'Common Teammates'));
  const typeMatchups = parseTypeMatchups(md);

  // Featured teams → PopularSets (up to 10, all the page serves). Each block carries the focal
  // species' set and the full six-Pokémon team it was played on.
  const sets: PopularSet[] = [];
  const teamBlocks = md.split(/### Team \d+ by /g).slice(1, 11);
  for (const block of teamBlocks) {
    const player = block.split('\n')[0]?.trim() ?? '';
    const record = block.match(/\*Record: (.+?)\*/)?.[1] ?? '';
    const event = block.match(/\*Event:\s*(.+?)\*/)?.[1]?.trim();
    // "**Pokemon**: Indeedee, Glimmora-Mega, Sneasler, Ninetales-Alola, Charizard-Mega-Y, Garchomp"
    const membersM = block.match(/\*\*Pokemon\*\*:\s*(.+)/);
    const members = membersM ? membersM[1].split(',').map((m) => m.trim()).filter(Boolean) : [];
    const abilityM = block.match(/\*\*Ability\*\*: (.+)/);
    const itemM = block.match(/\*\*Item\*\*: (.+)/);
    const movesM = block.match(/\*\*Moves\*\*: (.+)/);
    if (abilityM && itemM && movesM) {
      const natureM = block.match(/\*\*Nature\*\*: (.+)/);
      const statM = block.match(/\*\*(?:EVs?|SPs?)\*\*: (.+)/);
      const nature = natureM ? natureM[1].trim().replace(/ Nature$/i, '') : undefined;
      const sp = statM ? parseSetStatLine(statM[1].trim()) : undefined;
      sets.push({
        label: record ? `${player} (${record})` : player,
        ability: abilityM[1].trim(),
        item: itemM[1].trim(),
        moves: movesM[1].split(',').map((m) => m.trim()),
        ...(nature ? { nature } : {}),
        ...(sp ? { sp } : {}),
        members,
        ...(event ? { event } : {}),
      });
    }
  }

  // FAQ top spread: "EV spread of `32/0/14/0/20/0`" (HP/Atk/Def/SpA/SpD/Spe)
  const STAT_ORDER_FAQ = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const spreadM = md.match(/EV spread of `(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)`/);
  const topSpread: Record<string, number> | undefined = spreadM
    ? Object.fromEntries(
        STAT_ORDER_FAQ.map((s, i) => [s, Math.min(32, parseInt(spreadM[i + 1], 10))]).filter(([, v]) => (v as number) > 0),
      )
    : undefined;

  return {
    species,
    usagePct,
    ...(winRatePct != null ? { winRatePct } : {}),
    ...(record ? { record } : {}),
    moves,
    items,
    abilities,
    teammates,
    sets,
    ...(topSpread ? { topSpread } : {}),
    ...(typeMatchups ? { typeMatchups } : {}),
  };
}

function parseRankings(md: string): UsageRank[] {
  const ranks: UsageRank[] = [];
  for (const line of md.split('\n')) {
    // "Best 50 Pokemon by Usage" table row. The record is W-L-T on some formats and W-L on others
    // (Reg M-C launched with "1541-1406"), so the ties segment is optional:
    // "| 1 | **Garchomp** | N/A% | 51.371% | 14863-14069-23 | [View](…) | [AI](…) |"
    const t = line.match(
      /^\|\s*(\d+)\s*\|\s*\*\*(.+?)\*\*\s*\|\s*([0-9.]+|N\/A)%?\s*\|\s*([0-9.]+|N\/A)%?\s*\|\s*(\d+-\d+(?:-\d+)?)\s*\|/,
    );
    if (t) {
      ranks.push({
        rank: parseInt(t[1]),
        species: t[2].trim(),
        usagePct: t[3] === 'N/A' ? null : parseFloat(t[3]),
        ...(t[4] !== 'N/A' ? { winRatePct: parseFloat(t[4]) } : {}),
        record: t[5],
      });
      continue;
    }
    // Legacy numbered-list layout: "1. **Garchomp** - 41%"
    const m = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*.*?([0-9.]+)%/);
    if (m) ranks.push({ rank: parseInt(m[1]), species: m[2].trim(), usagePct: parseFloat(m[3]) });
  }
  return ranks;
}
