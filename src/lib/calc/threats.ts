/**
 * Threat matrix — one set measured against the live metagame, entirely from the engine.
 *
 * Given a focal set, this walks the current Pikalytics usage rankings, rebuilds each opponent from
 * their real usage data (item, ability, nature, SP, top moves), and runs `calcDamage` in both
 * directions. What comes back is a per-opponent verdict plus a prompt-ready summary of what this
 * set reliably threatens, what reliably threatens it, and where neither side gets a clean KO.
 *
 * What this module guarantees:
 *   - Every number originates in `src/lib/calc/engine.ts`. No type chart, damage formula, or bulk
 *     heuristic lives here; KO tiers are derived arithmetically from the engine's own min/max roll
 *     and `defenderMaxHP`, and the engine's `koChance` text is carried through verbatim.
 *   - "OHKOes" and "rolls to OHKO" stay distinct. A tier is `guaranteed` only when the *minimum*
 *     roll reaches it; when only the maximum roll does, `guaranteed` is false at the same tier.
 *   - Bounded work per request: opponents are capped (`MAX_OPPONENTS`), moves are capped at 4 per
 *     side, so a default request is at most 20 opponents × (4 offence + 4 defence) = 160 calcs.
 *   - Fail-soft. An opponent that cannot be built (no usage data) or cannot be calced (forme
 *     naming, a move outside the dex) is recorded in `skipped` with a reason; the rest still
 *     return. Only a total failure to reach the rankings produces an empty matrix.
 *   - Doubles, Level 50, no Terastallization — the Champions format, matching the rest of the app.
 *   - A computed matrix is cached under the DETERMINISTIC policy in `src/lib/cache/persistent.ts`:
 *     the key is a content hash of every input the answer depends on (the resolved focal set, the
 *     ruleset, the opponent count, and the resolved usage snapshot the opponents came from), so the
 *     same inputs can never produce a different answer and the result is kept until the schema
 *     version moves. A repeat request costs no network calls and no calcs, and with Firebase admin
 *     credentials present it survives a cold start instead of being re-derived per container.
 *
 * Layering note: opponent sets are rebuilt here rather than imported from `src/lib/ai/tools.ts`
 * (`buildSetFromUsage`). That module is the AI tool surface and it imports *this* one to register
 * the declaration below (`executeSharedTool` dispatches `threatMatrix`) — importing it back would
 * close a cycle. `buildOpponentSet` is the same few lines of fill-from-usage logic, kept local so
 * `lib/calc` never depends on `lib/ai`.
 *
 * Server-only (calc engine + Pikalytics fetches).
 */
import { Type, type FunctionDeclaration } from '@google/genai';
import { calcDamage, type CalcResult, type MonInput } from '@/lib/calc/engine';
import type { SpSpread } from '@/lib/calc/sp';
import { fetchFormatRankings, fetchUsage, resolveUsageFormat, type UsageRank } from '@/lib/data/usage';
import { getMove, isLegalSpecies, getSpecies } from '@/lib/data/champions';
import { calcSpecies, describeForms } from '@/lib/data/megas';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import { cached, contentKey, DETERMINISTIC } from '@/lib/cache/persistent';

export const DEFAULT_OPPONENTS = 20;
/** Hard cap on opponents per request — the serverless budget, not a preference. */
export const MAX_OPPONENTS = 30;
/** Both sides are limited to a real four-move set. */
export const MAX_MOVES_PER_SIDE = 4;
/** How many usage pages may be in flight at once. Keeps a 30-opponent request off Pikalytics' back. */
const FETCH_CONCURRENCY = 8;

/**
 * Schema version of `ThreatMatrixResult` in the `threat-matrix` cache namespace. A stored matrix is
 * handed back as this type on the strength of this number alone, and it is kept indefinitely, so
 * bump it whenever a stored answer would come out differently today: the result or entry shape
 * changes, `classifyKo`/`decideOutcome` change what a verdict means, `summarizeThreatMatrix`
 * changes its prose, the opponent-set construction changes, or the calc engine's damage output
 * changes (an engine fix, a dataset rebuild, a ruleset delta that alters an existing matchup).
 */
const THREAT_MATRIX_SCHEMA_VERSION = 1;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ThreatSet {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  sp?: SpSpread;
  moves?: string[];
}

/** Coarse KO tier, derived from engine rolls against the defender's max HP. */
export type KoTier = 'OHKO' | '2HKO' | '3HKO+' | 'negligible';

export interface KoVerdict {
  tier: KoTier;
  /** True when the *minimum* roll already reaches this tier; false when only the maximum roll does. */
  guaranteed: boolean;
  /** "guaranteed OHKO", "rolls to OHKO", "guaranteed 2HKO", … — safe to paste into prose. */
  label: string;
  /** Ordering key, lower is stronger: guaranteed OHKO 0 … negligible 7. Internal to this module. */
  score: number;
}

export interface ThreatMoveResult {
  name: string;
  minPct: number;
  maxPct: number;
  minDamage: number;
  maxDamage: number;
  defenderMaxHP: number;
  /** The engine's own KO-chance sentence, verbatim. */
  koChance: string;
  /** The engine's Smogon-style result line. */
  desc: string;
  verdict: KoVerdict;
  /** Engine caveats (speed ties, Multiscale-at-full-HP). */
  flags: string[];
}

/**
 * How the two directions compare.
 *   threatens  — the focal set reaches at least a possible 2HKO and the opponent does not.
 *   threatened — the reverse.
 *   trade      — both sides OHKO (or roll to); move order decides, so check Speed.
 *   standoff   — neither side reaches a 2HKO. Nobody gets a clean KO.
 *   even       — both sides reach a 2HKO at the same strength.
 */
export type MatchupOutcome = 'threatens' | 'threatened' | 'trade' | 'standoff' | 'even';

export interface ThreatEntry {
  species: string;
  /** Position in the current usage rankings (1 = most used). */
  rank: number;
  usagePct: number | null;
  /** The opponent set that was actually calced, as rebuilt from usage. */
  set: Required<Pick<ThreatSet, 'species' | 'ability' | 'item' | 'nature' | 'sp' | 'moves'>>;
  /** Focal set's best damaging move into this opponent; null when none of its moves connect. */
  offense: ThreatMoveResult | null;
  /** The opponent's worst-case (for us) damaging move into the focal set; null when it has none. */
  defense: ThreatMoveResult | null;
  outcome: MatchupOutcome;
}

export interface SkippedOpponent {
  species: string;
  reason: string;
}

export interface ThreatMatrixResult {
  focal: Required<Pick<ThreatSet, 'species' | 'ability' | 'item' | 'nature' | 'sp' | 'moves'>>;
  ruleset: RulesetId;
  gameType: 'Doubles';
  /** Pikalytics format actually serving the numbers, and the preferred one when it fell back. */
  usageFormat: string;
  usageFallbackFrom: string | null;
  /** How many ranked opponents were requested. */
  requested: number;
  entries: ThreatEntry[];
  skipped: SkippedOpponent[];
  /** Total `calcDamage` invocations behind this result — the cost receipt. */
  calcCount: number;
  /** Prompt-ready prose. Every number in it came out of the engine. */
  summary: string;
}

// ─── KO classification ─────────────────────────────────────────────────────────

/**
 * Turn an engine result into a KO tier. `hits = ceil(maxHP / roll)` for each end of the range:
 * the maximum roll gives the best case the attacker can hope for (the tier), the minimum roll says
 * whether that tier is guaranteed. Nothing here re-derives damage — it only divides.
 */
export function classifyKo(result: CalcResult): KoVerdict {
  const hp = result.defenderMaxHP;
  if (!hp || result.maxDamage <= 0) {
    return { tier: 'negligible', guaranteed: true, label: 'no damage', score: 7 };
  }
  const bestCaseHits = Math.ceil(hp / result.maxDamage);
  const worstCaseHits = result.minDamage > 0 ? Math.ceil(hp / result.minDamage) : Infinity;

  const tier: KoTier =
    bestCaseHits <= 1 ? 'OHKO' : bestCaseHits === 2 ? '2HKO' : bestCaseHits <= 4 ? '3HKO+' : 'negligible';
  const guaranteed = worstCaseHits <= bestCaseHits;

  const tierIndex = tier === 'OHKO' ? 0 : tier === '2HKO' ? 1 : tier === '3HKO+' ? 2 : 3;
  const score = tierIndex * 2 + (guaranteed ? 0 : 1);

  const label =
    tier === 'negligible'
      ? guaranteed
        ? 'negligible'
        : 'negligible (5+ hits)'
      : guaranteed
        ? `guaranteed ${tier}`
        : `rolls to ${tier}`;
  return { tier, guaranteed, label, score };
}

/** Reaching at least a possible 2HKO — the bar for "this side has a clean KO in the matchup". */
function hasCleanKo(v: KoVerdict | null): boolean {
  return v != null && v.score <= 3;
}

function decideOutcome(offense: KoVerdict | null, defense: KoVerdict | null): MatchupOutcome {
  const off = offense?.score ?? 99;
  const def = defense?.score ?? 99;
  if (off <= 1 && def <= 1) return 'trade';
  const offKO = hasCleanKo(offense);
  const defKO = hasCleanKo(defense);
  if (offKO && !defKO) return 'threatens';
  if (defKO && !offKO) return 'threatened';
  if (!offKO && !defKO) return 'standoff';
  return off < def ? 'threatens' : def < off ? 'threatened' : 'even';
}

// ─── Set construction ──────────────────────────────────────────────────────────

type ResolvedSet = ThreatEntry['set'];

function toMonInput(set: ResolvedSet): MonInput {
  return {
    species: set.species,
    ability: set.ability || undefined,
    item: set.item || undefined,
    nature: set.nature || undefined,
    sp: set.sp,
  };
}

/**
 * Fill a set from the most common Pikalytics data for anything the caller left blank — the featured
 * tournament set first, then the top moves/items/abilities, then the FAQ spread. Mirrors
 * `buildSetFromUsage` in `lib/ai/tools.ts`; duplicated to keep `lib/calc` free of `lib/ai` (see the
 * layering note in the module header). Throws when there is nothing to build from.
 */
async function buildOpponentSet(species: string, ruleset: RulesetId): Promise<ResolvedSet> {
  const usage = await fetchUsage(species, ruleset).catch(() => null);
  if (!usage) throw new Error('no usage data');
  const featured = usage.sets?.[0];
  const moves = (featured?.moves?.length ? featured.moves : usage.moves.map((m) => m.name)).filter(Boolean);
  if (!moves.length) throw new Error('usage data has no moves');
  const item = featured?.item ?? usage.items[0]?.name ?? '';
  // A base species holding its stone fights as the Mega; calc the forme that actually takes the field.
  const forme = calcSpecies(species, item, ruleset);
  const formeAbility = forme !== species ? getSpecies(forme)?.abilities?.[0] : undefined;
  return {
    species: forme,
    ability: formeAbility ?? featured?.ability ?? usage.abilities[0]?.name ?? '',
    item,
    nature: featured?.nature ?? 'Hardy',
    sp: (featured?.sp as SpSpread | undefined) ?? (usage.topSpread as SpSpread | undefined) ?? {},
    moves: moves.slice(0, MAX_MOVES_PER_SIDE),
  };
}

/** Resolve the focal set, filling only what the caller omitted. Never fails on missing usage. */
async function resolveFocalSet(input: ThreatSet, ruleset: RulesetId): Promise<ResolvedSet> {
  const given = (input.moves ?? []).filter(Boolean);
  if (given.length && input.ability && input.item && input.nature) {
    return {
      species: input.species,
      ability: input.ability,
      item: input.item,
      nature: input.nature,
      sp: input.sp ?? {},
      moves: given.slice(0, MAX_MOVES_PER_SIDE),
    };
  }
  const filled = await buildOpponentSet(input.species, ruleset).catch(() => null);
  return {
    species: input.species,
    ability: input.ability ?? filled?.ability ?? '',
    item: input.item ?? filled?.item ?? '',
    nature: input.nature ?? filled?.nature ?? 'Hardy',
    sp: input.sp ?? filled?.sp ?? {},
    moves: (given.length ? given : (filled?.moves ?? [])).slice(0, MAX_MOVES_PER_SIDE),
  };
}

/**
 * Damaging moves only, capped at four, and only names the engine can resolve.
 *
 * `getMove` reads through the gen-0 repair layer in `data/champions.ts`, so `category` is
 * trustworthy here; the base-power tiebreak this used to need is gone. A move that still slips
 * through with an unknown category is caught downstream by the 0-damage guard in the calc loop.
 */
function damagingMoves(moves: string[]): string[] {
  return moves
    .filter((name) => {
      const m = getMove(name);
      return !!m && m.category !== 'Status';
    })
    .slice(0, MAX_MOVES_PER_SIDE);
}

// ─── Concurrency + cache ───────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── The matrix ────────────────────────────────────────────────────────────────

const DOUBLES_FIELD = { gameType: 'Doubles' as const };

function toMoveResult(name: string, r: CalcResult): ThreatMoveResult {
  return {
    name,
    minPct: r.minPct,
    maxPct: r.maxPct,
    minDamage: r.minDamage,
    maxDamage: r.maxDamage,
    defenderMaxHP: r.defenderMaxHP,
    koChance: r.koChance,
    desc: r.desc,
    verdict: classifyKo(r),
    flags: r.flags,
  };
}

export interface ThreatMatrixOptions {
  ruleset?: RulesetId;
  /** Ranked opponents to test, default 20, hard-capped at `MAX_OPPONENTS`. */
  opponents?: number;
}

/**
 * Compute the full two-way matchup profile for one set against the top of the live usage rankings.
 * Never throws for a single bad opponent; a species that cannot be built or calced lands in
 * `skipped`. Throws only if the focal species itself is not in the Champions dex.
 */
export async function computeThreatMatrix(
  input: ThreatSet,
  options: ThreatMatrixOptions = {},
): Promise<ThreatMatrixResult> {
  const ruleset = options.ruleset ?? DEFAULT_RULESET;
  const requested = Math.max(1, Math.min(MAX_OPPONENTS, Math.round(options.opponents ?? DEFAULT_OPPONENTS)));
  if (!getSpecies(input.species)) throw new Error(`${input.species} is not in the Champions dex.`);

  const focal = await resolveFocalSet(input, ruleset);

  // Resolved before the cache key, because the key has to contain them: the rankings ARE the
  // metagame this matrix is a statement about. Their usage percentages and W-L records move every
  // time Pikalytics refreshes, so hashing them in is what stops a permanently-cached matrix from
  // describing a metagame that no longer exists — and the opponent sets are rebuilt from the same
  // refresh, so they cannot drift underneath a key that still matches.
  const [ranked, source] = await Promise.all([
    fetchFormatRankings(ruleset).catch(() => []),
    resolveUsageFormat(ruleset).catch(() => ({ format: 'unknown', fallbackFrom: null })),
  ]);

  const legalitySkipped: SkippedOpponent[] = [];
  const candidates = ranked
    .filter((r) => {
      if (isLegalSpecies(r.species, ruleset)) return true;
      legalitySkipped.push({ species: r.species, reason: `not legal in ${getRuleset(ruleset).short}` });
      return false;
    })
    .slice(0, requested);

  // Everything the answer depends on. Leaving any of it out would serve a stale matrix forever.
  const key = contentKey({ focal, ruleset, requested, source, candidates, legalitySkipped });
  return cached(
    'threat-matrix',
    key,
    { ...DETERMINISTIC, version: THREAT_MATRIX_SCHEMA_VERSION },
    () => buildMatrix(focal, ruleset, requested, source, candidates, legalitySkipped),
  );
}

/** The matrix itself: the loader behind the cache, run only on a miss. Pure given its arguments. */
async function buildMatrix(
  focal: ResolvedSet,
  ruleset: RulesetId,
  requested: number,
  source: { format: string; fallbackFrom: string | null },
  candidates: UsageRank[],
  legalitySkipped: SkippedOpponent[],
): Promise<ThreatMatrixResult> {
  // Copied, never appended to in place: the caller's array outlives this loader.
  const skipped: SkippedOpponent[] = [...legalitySkipped];
  const focalMon = toMonInput(focal);
  const focalMoves = damagingMoves(focal.moves);

  let calcCount = 0;
  const built = await mapWithConcurrency(candidates, FETCH_CONCURRENCY, async (rank) => {
    try {
      return { rank, set: await buildOpponentSet(rank.species, ruleset) };
    } catch (e) {
      return { rank, error: (e as Error).message };
    }
  });

  const entries: ThreatEntry[] = [];
  for (const item of built) {
    if (!('set' in item) || !item.set) {
      skipped.push({ species: item.rank.species, reason: 'error' in item ? item.error! : 'could not build a set' });
      continue;
    }
    const oppSet = item.set;
    const oppMon = toMonInput(oppSet);

    // Offence: best result the focal set can produce against this opponent.
    let offense: ThreatMoveResult | null = null;
    let offenseError: string | null = null;
    for (const name of focalMoves) {
      try {
        calcCount++;
        const r = toMoveResult(name, calcDamage(focalMon, oppMon, { name }, DOUBLES_FIELD));
        // A move the defender is immune to is not this set's "best answer" — leave offense null
        // rather than reporting a 0% roll as the matchup.
        if (r.maxDamage <= 0) continue;
        if (!offense || r.verdict.score < offense.verdict.score || (r.verdict.score === offense.verdict.score && r.maxPct > offense.maxPct)) {
          offense = r;
        }
      } catch (e) {
        offenseError = (e as Error).message;
      }
    }

    // Defence: worst case the opponent's own usage moves produce against the focal set.
    let defense: ThreatMoveResult | null = null;
    let defenseError: string | null = null;
    for (const name of damagingMoves(oppSet.moves)) {
      try {
        calcCount++;
        const r = toMoveResult(name, calcDamage(oppMon, focalMon, { name }, DOUBLES_FIELD));
        if (r.maxDamage <= 0) continue;
        if (!defense || r.verdict.score < defense.verdict.score || (r.verdict.score === defense.verdict.score && r.maxPct > defense.maxPct)) {
          defense = r;
        }
      } catch (e) {
        defenseError = (e as Error).message;
      }
    }

    if (!offense && !defense) {
      skipped.push({ species: oppSet.species, reason: offenseError ?? defenseError ?? 'no damaging moves on either side' });
      continue;
    }
    entries.push({
      species: oppSet.species,
      rank: item.rank.rank,
      usagePct: item.rank.usagePct,
      set: oppSet,
      offense,
      defense,
      outcome: decideOutcome(offense?.verdict ?? null, defense?.verdict ?? null),
    });
  }

  const result: ThreatMatrixResult = {
    focal,
    ruleset,
    gameType: 'Doubles',
    usageFormat: source.format,
    usageFallbackFrom: source.fallbackFrom,
    requested,
    entries,
    skipped,
    calcCount,
    summary: '',
  };
  result.summary = summarizeThreatMatrix(result);
  return result;
}

// ─── Summary ───────────────────────────────────────────────────────────────────

function fmtSpread(sp: SpSpread): string {
  return Object.entries(sp).filter(([, v]) => v && v > 0).map(([k, v]) => `${k}:${v}`).join('/') || 'none';
}

/** "Earthquake 106.1–125% (guaranteed OHKO)" — the move half of a summary line. */
function moveBit(m: ThreatMoveResult | null): string {
  return m ? `${m.name} ${m.minPct}–${m.maxPct}% (${m.verdict.label})` : 'no damage';
}

function offenseLine(e: ThreatEntry): string {
  return `${e.species} — ${moveBit(e.offense)}`;
}

function defenseLine(e: ThreatEntry): string {
  return `${e.species} — ${moveBit(e.defense)}`;
}

function twoWayLine(e: ThreatEntry): string {
  return `${e.species} — out: ${moveBit(e.offense)}; in: ${moveBit(e.defense)}`;
}

function section(title: string, lines: string[]): string {
  return lines.length ? `${title} (${lines.length}):\n  ${lines.join('\n  ')}` : '';
}

/**
 * Compact prose for a model prompt. Groups the matrix into what this set beats, what beats it,
 * the OHKO races, and the standoffs. Percentages and KO labels are copied from the engine results
 * already in the matrix — this function computes nothing.
 */
export function summarizeThreatMatrix(m: ThreatMatrixResult): string {
  const rules = getRuleset(m.ruleset);
  const head =
    `Threat matrix — ${m.focal.species} @ ${m.focal.item || '—'} | ${m.focal.ability || '—'} | ` +
    `${m.focal.nature || 'Hardy'} | SP ${fmtSpread(m.focal.sp)} | ${m.focal.moves.join(' / ') || 'no moves'}\n` +
    `Format: ${rules.short}, Doubles, Level 50, no Tera. Tested against the top ${m.entries.length} of current usage ` +
    `(${m.usageFormat}${m.usageFallbackFrom ? `, a fallback — Pikalytics has no ${m.usageFallbackFrom} data yet` : ''}).`;

  if (!m.entries.length) {
    return `${head}\nNo opponents could be evaluated${m.skipped.length ? ` (${m.skipped.length} skipped)` : ''}.`;
  }

  const byScore = (a: ThreatEntry, b: ThreatEntry) => (a.offense?.verdict.score ?? 99) - (b.offense?.verdict.score ?? 99);
  const byDefScore = (a: ThreatEntry, b: ThreatEntry) => (a.defense?.verdict.score ?? 99) - (b.defense?.verdict.score ?? 99);

  const threatens = m.entries.filter((e) => e.outcome === 'threatens' && e.offense).sort(byScore);
  const threatened = m.entries.filter((e) => e.outcome === 'threatened' && e.defense).sort(byDefScore);
  const trades = m.entries.filter((e) => e.outcome === 'trade');
  const standoffs = m.entries.filter((e) => e.outcome === 'standoff');
  const even = m.entries.filter((e) => e.outcome === 'even');

  const parts = [
    head,
    section('Reliably threatens', threatens.map(offenseLine)),
    section('Reliably threatened by', threatened.map(defenseLine)),
    section('OHKO race — move order decides, check Speed', trades.map(twoWayLine)),
    section('Both sides 2HKO', even.map(twoWayLine)),
    section('Standoff — neither side gets a clean KO', standoffs.map(twoWayLine)),
  ].filter(Boolean);

  if (m.skipped.length) {
    parts.push(`Skipped (${m.skipped.length}): ${m.skipped.map((s) => `${s.species} (${s.reason})`).join(', ')}.`);
  }
  return parts.join('\n');
}

// ─── AI tool surface ───────────────────────────────────────────────────────────

export const threatMatrixDeclaration: FunctionDeclaration = {
  name: 'threatMatrix',
  description:
    "Run engine damage calcs for one set in both directions against the top of the live Champions usage rankings, and return its matchup profile: what it reliably OHKOes or 2HKOes, what reliably OHKOes or 2HKOes it, the OHKO races where move order decides, and the standoffs where neither side gets a clean KO. REQUIRED before any claim about a set's overall metagame matchup, what it 'beats', what 'walls' it, or what 'threatens' it — never answer that from memory. One call replaces dozens of calcDamage calls; every number comes from the same engine.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      species: { type: Type.STRING, description: 'Exact engine species name, e.g. "Dragonite-Mega".' },
      ability: { type: Type.STRING, description: 'Ability. Omit to use the most common one from usage data.' },
      item: { type: Type.STRING, description: 'Held item. Omit to use the most common one from usage data.' },
      nature: { type: Type.STRING, description: 'Nature. Omit to use the most common one from usage data.' },
      sp: {
        type: Type.OBJECT,
        description: 'Stat Points per stat (each 0–32, total ≤66). Omit to use the most common spread from usage data.',
        properties: {
          hp: { type: Type.NUMBER },
          atk: { type: Type.NUMBER },
          def: { type: Type.NUMBER },
          spa: { type: Type.NUMBER },
          spd: { type: Type.NUMBER },
          spe: { type: Type.NUMBER },
        },
      },
      moves: {
        type: Type.ARRAY,
        description: 'The set\'s moves (up to 4). Status moves are ignored. Omit to use the most common moves from usage data.',
        items: { type: Type.STRING },
      },
      opponents: {
        type: Type.NUMBER,
        description: `How many of the top-usage Pokémon to test against. Default ${DEFAULT_OPPONENTS}, maximum ${MAX_OPPONENTS}.`,
      },
    },
    required: ['species'],
  },
};

export interface ThreatMatrixArgs {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  sp?: SpSpread;
  moves?: string[];
  opponents?: number;
}

/**
 * Tool executor, same shape as the executors in `lib/ai/tools.ts`: never throws, returns
 * `{ error }` on failure. Hands the model the prose summary plus the structured entries so it can
 * quote an exact roll without a second call.
 */
export async function executeThreatMatrix(
  args: ThreatMatrixArgs,
  ruleset: RulesetId = DEFAULT_RULESET,
): Promise<unknown> {
  if (!args?.species) return { error: 'species is required.' };
  try {
    const m = await computeThreatMatrix(
      { species: args.species, ability: args.ability, item: args.item, nature: args.nature, sp: args.sp, moves: args.moves },
      { ruleset, opponents: args.opponents },
    );
    return {
      summary: m.summary,
      focal: m.focal,
      usageFormat: m.usageFormat,
      ...(m.usageFallbackFrom
        ? { dataCaveat: `Pikalytics has not published ${getRuleset(ruleset).short} data yet — the rankings and opponent sets are from ${m.usageFormat}.` }
        : {}),
      matchups: m.entries.map((e) => ({
        species: e.species,
        rank: e.rank,
        outcome: e.outcome,
        opponentSet: `${e.set.item || '—'} | ${e.set.ability || '—'} | ${e.set.nature} | SP ${fmtSpread(e.set.sp)} | ${e.set.moves.join(' / ')}${describeForms(e.set.species, e.set.item) ? ` | ${describeForms(e.set.species, e.set.item)}` : ''}`,
        offense: e.offense && { move: e.offense.name, pct: `${e.offense.minPct}–${e.offense.maxPct}%`, ko: e.offense.verdict.label, koChance: e.offense.koChance },
        defense: e.defense && { move: e.defense.name, pct: `${e.defense.minPct}–${e.defense.maxPct}%`, ko: e.defense.verdict.label, koChance: e.defense.koChance },
      })),
      skipped: m.skipped,
      calcCount: m.calcCount,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
