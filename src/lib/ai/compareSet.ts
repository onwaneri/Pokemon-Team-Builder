/**
 * Dynamic comparison sets for the Damage Calc and Speed Tier screens.
 *
 * Given the user's own Pokémon (the "focus"), pick the opponents worth comparing against right
 * now: for the calc, what this set needs to hit and what threatens it; for speed tiers, the
 * benchmarks around its Speed bracket plus the format's speed-control pieces. Gemini chooses the
 * species from the live usage rankings (structured JSON, no free text); every set is then built
 * from Pikalytics data, so nothing on screen comes from model memory. Without an API key the
 * list falls back to the top of the rankings.
 *
 * Server-only.
 */
import { Type } from '@google/genai';
import type { LlmClient } from '@/lib/ai/llm';
import { fetchFormatRankings, resolveUsageFormat } from '@/lib/data/usage';
import { isLegalSpecies, getSpecies } from '@/lib/data/champions';
import { championsMeta } from '@/lib/data/meta';
import { buildSetFromUsage, generateJson } from '@/lib/ai/tools';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import type { CalcMonSet, CompareOpponent, CompareSetResponse } from '@/lib/ai/types';
import type { SpSpread } from '@/lib/calc/sp';

export type CompareMode = 'calc' | 'speed';

export interface FocusMon {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  sp?: SpSpread;
  moves?: string[];
}

export interface CompareSetInput {
  mode: CompareMode;
  /** The user's Pokémon the comparison is built around (one for calc, one or more for speed). */
  focus: FocusMon[];
  /** Species already on the user's team — context only, never suggested back. */
  teamSpecies?: string[];
  count?: number;
  regulation?: RulesetId;
  /** Model to choose with; null = no key available, fall back to the rankings. */
  client?: LlmClient | null;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { data: CompareSetResponse; ts: number }>();

function cacheKey(input: CompareSetInput, count: number): string {
  const focus = input.focus.map((f) => [f.species, f.item ?? '', f.nature ?? '', (f.moves ?? []).filter(Boolean).join('|')].join('~'));
  return `${input.client ? 'ai' : 'rank'}:${input.regulation ?? DEFAULT_RULESET}:${input.mode}:${count}:${focus.join(';')}`;
}

function describeFocus(f: FocusMon): string {
  const data = getSpecies(f.species);
  const types = data ? data.types.join('/') : '?';
  const bs = data ? `HP ${data.baseStats.hp} / Atk ${data.baseStats.atk} / Def ${data.baseStats.def} / SpA ${data.baseStats.spa} / SpD ${data.baseStats.spd} / Spe ${data.baseStats.spe}` : 'unknown base stats';
  const sp = Object.entries(f.sp ?? {}).filter(([, v]) => v && v > 0).map(([k, v]) => `${k}:${v}`).join('/') || 'none';
  return `${f.species} (${types}; base ${bs}) @ ${f.item || '—'} | ${f.ability || '—'} | ${f.nature || 'Hardy'} | SP ${sp} | ${(f.moves ?? []).filter(Boolean).join(' / ') || 'no moves'}`;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    picks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          species: { type: Type.STRING, description: 'Exact species name from the candidate list.' },
          reason: { type: Type.STRING, description: 'At most 12 words on why this comparison matters.' },
        },
        required: ['species', 'reason'],
      },
    },
  },
  required: ['picks'],
};

async function choosePicks(
  input: CompareSetInput,
  candidates: string[],
  count: number,
  ruleset: RulesetId,
  fallbackNote: string,
  client: LlmClient | null | undefined,
): Promise<{ species: string; reason: string }[] | null> {
  if (!client) return null;
  const rules = getRuleset(ruleset);

  const goal = input.mode === 'calc'
    ? `Pick the ${count} opponents most worth running damage calcs against for this set: the common threats it must be able to hit (targets its attacks are meant for, including the bulky answers that check it) and the attackers that threaten to KO it. Mix both directions. Prefer the highest-usage Pokémon when relevance is similar.`
    : `Pick the ${count} opponents most worth comparing Speed against for these team members: the common Pokémon sitting just above and just below their Speed tier, the format's fastest common threats, Choice Scarf users, Tailwind setters, and Trick Room setters. Prefer the highest-usage Pokémon when relevance is similar.`;

  const prompt = `${goal}

Focus (the user's Pokémon):
${input.focus.map(describeFocus).join('\n')}
${input.teamSpecies?.length ? `\nRest of the user's team (context only — do not pick these): ${input.teamSpecies.join(', ')}` : ''}

Candidates (${rules.short} pool, ordered by current usage rankings, highest first${fallbackNote}). Choose ONLY from this list, no duplicates, never the focus species:
${candidates.join(', ')}

Return exactly ${count} picks.`;

  const parsed = await generateJson<{ picks?: { species: string; reason: string }[] }>(client, {
    system: `${championsMeta(ruleset)}\n\nYou choose comparison targets for a Pokémon Champions (VGC doubles, ${rules.short}) tool. No Terastallization exists. Base your relevance judgement on typing, base stats, and the moves shown — never on remembered usage numbers. Output JSON only.`,
    prompt,
    schema: responseSchema,
  });
  return parsed?.picks ?? null;
}

export async function generateCompareSet(input: CompareSetInput): Promise<CompareSetResponse> {
  const count = Math.max(3, Math.min(10, input.count ?? (input.mode === 'calc' ? 6 : 8)));
  const key = cacheKey(input, count);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  const ruleset = input.regulation ?? DEFAULT_RULESET;
  const rules = getRuleset(ruleset);
  const focusSpecies = new Set(input.focus.map((f) => f.species));
  const [ranked, usageSource] = await Promise.all([fetchFormatRankings(ruleset).catch(() => []), resolveUsageFormat(ruleset).catch(() => null)]);
  const rankings = ranked.map((r) => r.species).filter((s) => isLegalSpecies(s, ruleset) && !focusSpecies.has(s));
  // Additions new to this ruleset have no usage yet; append them so they can still be chosen on merit.
  const additions = rules.addedSpecies.filter((s) => isLegalSpecies(s, ruleset) && !focusSpecies.has(s) && !rankings.includes(s));
  const candidates = [...rankings.slice(0, 40), ...additions];
  const fallbackNote = usageSource?.fallbackFrom ? `; usage is still ${usageSource.format} data, and the unranked names at the end are ${rules.short} additions with no usage yet` : '';

  let picks = candidates.length >= count ? await choosePicks(input, candidates, count, ruleset, fallbackNote, input.client) : null;
  let source: CompareSetResponse['source'] = 'ai';
  const candidateSet = new Set(candidates.map((c) => c.toLowerCase()));
  picks = (picks ?? [])
    .map((p) => ({ species: candidates.find((c) => c.toLowerCase() === p.species.toLowerCase()) ?? p.species, reason: p.reason }))
    .filter((p) => candidateSet.has(p.species.toLowerCase()) || isLegalSpecies(p.species, ruleset))
    .filter((p, i, arr) => !focusSpecies.has(p.species) && arr.findIndex((q) => q.species === p.species) === i)
    .slice(0, count);

  if (!picks.length) {
    source = 'rankings';
    picks = candidates.slice(0, count).map((species, i) => ({ species, reason: `#${i + 1} in current usage` }));
  }

  const sets = await Promise.all(picks.map((p) => buildSetFromUsage(p.species, {}, ruleset).catch<CalcMonSet | null>(() => null)));
  const opponents: CompareOpponent[] = picks
    .map((p, i) => (sets[i] ? { ...sets[i]!, reason: p.reason } : null))
    .filter((o): o is CompareOpponent => o !== null);

  const data: CompareSetResponse = { opponents, source };
  if (opponents.length) cache.set(key, { data, ts: Date.now() });
  return data;
}
