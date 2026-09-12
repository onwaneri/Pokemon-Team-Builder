/**
 * Live usage stats from the Pikalytics AI endpoint.
 *
 * Endpoint: GET https://www.pikalytics.com/ai/pokedex/{format}/{pokemon}
 * Format: chosen per ruleset (src/lib/rulesets → pikalyticsFormats, tried in order). A regulation
 * Pikalytics has not published yet falls back to its predecessor; `resolveUsageFormat` reports
 * when that happens so the UI and the model can label the numbers honestly.
 * Response: text/markdown, refreshed monthly or on major events.
 *
 * The markdown layout is not a contract — if Pikalytics changes it, the regex parsers stop matching.
 * fetchUsage treats "fetched a real page but parsed nothing" as a parser-drift failure and returns
 * null rather than serving empty lists as if they were real usage data.
 *
 * Server-only — never import into client code.
 */

import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';

const BASE = 'https://www.pikalytics.com/ai/pokedex';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-process cache
const MISSING_FORMAT_RETRY_MS = 5 * 60 * 1000; // re-probe unpublished formats every 5 minutes
const HEADERS = { 'User-Agent': 'VGC-Champions-Tool/1.0' };
// Pikalytics occasionally stalls; a hung fetch inside a serverless request would run into the
// platform's function timeout and surface as a raw error page, so every upstream call is capped.
const UPSTREAM_TIMEOUT_MS = 10_000;

const memCache = new Map<string, { data: UsageData; ts: number }>();
const formatPageCache = new Map<string, { md: string | null; ts: number }>();

/** Fetch a format's landing page (rankings); null when Pikalytics has no data for it. Cached 1h. */
async function fetchFormatPage(format: string): Promise<string | null> {
  const cached = formatPageCache.get(format);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.md;
  let md: string | null = null;
  try {
    const res = await fetch(`${BASE}/${format}`, { headers: HEADERS, next: { revalidate: 3600 }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.ok) {
      const text = await res.text();
      // "# Format Not Found" is a 200 with a stub body; a real page has a rankings table.
      if (!/^#\s*Format Not Found/i.test(text.trim()) && parseRankings(text).length > 0) md = text;
    }
  } catch {
    md = null;
  }
  // A format that is not published yet is re-checked every few minutes so a newly released
  // regulation's data shows up without a restart; real pages keep the full 1h TTL.
  formatPageCache.set(format, { md, ts: md ? Date.now() : Date.now() - CACHE_TTL_MS + MISSING_FORMAT_RETRY_MS });
  return md;
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
  sets: PopularSet[];
  topSpread?: Record<string, number>;
}

export async function fetchUsage(species: string, ruleset: RulesetId = DEFAULT_RULESET): Promise<UsageData | null> {
  const { format } = await resolveUsageFormat(ruleset);
  const key = `${format}:${species.toLowerCase()}`;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  try {
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
    // means the markdown format changed (or the page is an error shell) — don't cache or serve it.
    if (
      md.length > 200 &&
      !data.moves.length && !data.items.length && !data.abilities.length &&
      !data.sets.length && data.usagePct === 0
    ) {
      return null;
    }
    // Pikalytics stores spread data under the base species for Megas/formes
    if (!data.topSpread) {
      const base = species.replace(/-Mega(?:-[XY])?$/i, '').replace(/-Eternal$/, '');
      if (base !== species) {
        try {
          const baseRes = await fetch(`${BASE}/${format}/${encodeURIComponent(base)}`, {
            headers: HEADERS,
            next: { revalidate: 3600 },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (baseRes.ok) {
            const baseMd = await baseRes.text();
            const baseData = parseMarkdown(baseMd, base);
            if (baseData.topSpread) data = { ...data, topSpread: baseData.topSpread };
          }
        } catch { /* best-effort */ }
      }
    }
    memCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
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

  // Featured teams → PopularSets (up to 3)
  const sets: PopularSet[] = [];
  const teamBlocks = md.split(/### Team \d+ by /g).slice(1, 4);
  for (const block of teamBlocks) {
    const player = block.split('\n')[0]?.trim() ?? '';
    const record = block.match(/\*Record: (.+?)\*/)?.[1] ?? '';
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
    sets,
    ...(topSpread ? { topSpread } : {}),
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
