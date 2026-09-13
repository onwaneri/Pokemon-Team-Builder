/**
 * Shared Gemini tool declarations, executors, and the legality gate used by every AI entry point
 * (chat, team builder, compare sets). Keeping them here means each caller exposes the same
 * engine-backed tools and the same validation — a set that is illegal for one is illegal for all.
 *
 * The shared surface is `calcDamage`, `lookupUsage`, `compareSpeed`, and `threatMatrix`. The last
 * one is declared and executed in `src/lib/calc/threats.ts` and only re-exported here: this module
 * imports that one, never the reverse, so `lib/calc` stays free of `lib/ai` (see the layering note
 * in that file's header).
 *
 * Server-only (calc engine + Pikalytics fetches).
 */
import { Type, type FunctionDeclaration } from '@google/genai';
import type { LlmClient, LlmMessage } from '@/lib/ai/llm';
import { calcDamage, compareSpeed, type MonInput, type MoveInput, type FieldInput, type SpeedMonInput } from '@/lib/calc/engine';
import { fetchUsage, resolveUsageFormat, type TypeMatchup } from '@/lib/data/usage';
import { validateLegality, legalAbilities, isLegalItem, isLegalSpecies, getSpecies } from '@/lib/data/champions';
import { learnsetIssues } from '@/lib/data/learnsets';
import { calcSpecies, megaFormsFor, formsJson, isMegaSpecies, stoneForMega } from '@/lib/data/megas';
import { validateSp, type SpSpread } from '@/lib/calc/sp';
import type { CalcMonSet } from '@/lib/ai/types';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import { threatMatrixDeclaration, executeThreatMatrix, type ThreatMatrixArgs } from '@/lib/calc/threats';

// Re-exported so every AI caller assembles its tool list from this one module.
export { threatMatrixDeclaration, type ThreatMatrixArgs };


/** "atk:32/spe:32" style summary of an SP spread for prompts; 'none' when empty. */
export function fmtSp(sp: SpSpread | undefined): string {
  return Object.entries(sp ?? {}).filter(([, v]) => v && v > 0).map(([k, v]) => `${k}:${v}`).join('/') || 'none';
}

// ─── Schemas ───────────────────────────────────────────────────────────────────

export const spSchema = {
  type: Type.OBJECT,
  description: 'Stat Points per stat (each 0–32, total ≤66).',
  properties: {
    hp: { type: Type.NUMBER },
    atk: { type: Type.NUMBER },
    def: { type: Type.NUMBER },
    spa: { type: Type.NUMBER },
    spd: { type: Type.NUMBER },
    spe: { type: Type.NUMBER },
  },
};

export function monSchema(description: string) {
  return {
    type: Type.OBJECT,
    description,
    properties: {
      species: { type: Type.STRING, description: 'Exact engine species name, e.g. "Dragonite-Mega".' },
      ability: { type: Type.STRING },
      item: { type: Type.STRING },
      nature: { type: Type.STRING },
      sp: spSchema,
    },
    required: ['species'],
  };
}

export const calcDamageDeclaration: FunctionDeclaration = {
  name: 'calcDamage',
  description:
    'Compute exact Pokémon Champions damage for an attacker using a move against a defender. Returns 16 rolls, min/max damage, percent of the defender max HP, a KO chance, a Smogon-style description, and caveat flags (speed ties, Multiscale).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      attacker: monSchema('The attacking Pokémon set.'),
      defender: monSchema('The defending Pokémon set.'),
      moveName: { type: Type.STRING, description: 'Exact move name, e.g. "Brave Bird".' },
      gameType: { type: Type.STRING, description: '"Doubles" (default) or "Singles".' },
      weather: { type: Type.STRING, description: 'Optional weather: Sun, Rain, Sand, or Snow.' },
      terrain: { type: Type.STRING, description: 'Optional terrain: Electric, Grassy, Psychic, or Misty.' },
      isCrit: { type: Type.BOOLEAN, description: 'Whether the move is a critical hit.' },
    },
    required: ['attacker', 'defender', 'moveName'],
  },
};

export const lookupUsageDeclaration: FunctionDeclaration = {
  name: 'lookupUsage',
  description:
    'Fetch Pikalytics usage data for a Pokémon in the Champions format. Returns top moves, items, and abilities by usage percentage, the most common teammates it shares a team with, its defensive type matchups, the most common SP spread (sometimes borrowed from the previous regulation, in which case the result says so), and featured tournament sets with the full six-Pokémon teams they were played on. Use this before proposing or placing any set, and before any claim about synergy, teammates, or what a Pokémon is weak to, so the details come from real data, not memory.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      species: { type: Type.STRING, description: 'Pokémon species name, e.g. "Garchomp".' },
    },
    required: ['species'],
  },
};

export const compareSpeedDeclaration: FunctionDeclaration = {
  name: 'compareSpeed',
  description:
    'Engine-computed move-order comparison. REQUIRED before any "X outspeeds Y" claim or Speed number — returns each Pokémon\'s exact Speed stat (nature + SP applied) and effective Speed after stages, paralysis, Choice Scarf, and Tailwind, sorted into move order (Trick Room aware), with speed-tie flags.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mons: {
        type: Type.ARRAY,
        description: 'The Pokémon to compare (at least 2).',
        items: {
          type: Type.OBJECT,
          properties: {
            species: { type: Type.STRING, description: 'Exact engine species name, e.g. "Dragonite-Mega".' },
            label: { type: Type.STRING, description: 'Optional display label, e.g. "my Garchomp" vs "opposing Garchomp".' },
            nature: { type: Type.STRING },
            item: { type: Type.STRING, description: 'Held item — Choice Scarf multiplies Speed by 1.5.' },
            speSP: { type: Type.NUMBER, description: 'Speed SP (0–32). Use lookupUsage topSpread when the real investment is unknown.' },
            stage: { type: Type.NUMBER, description: 'Speed stat stage −6…+6 (e.g. −1 after Icy Wind).' },
            paralyzed: { type: Type.BOOLEAN },
            tailwind: { type: Type.BOOLEAN, description: 'Whether this Pokémon\'s side has Tailwind up.' },
          },
          required: ['species'],
        },
      },
      trickRoom: { type: Type.BOOLEAN, description: 'Whether Trick Room is active.' },
    },
    required: ['mons'],
  },
};

// ─── Tool input types ──────────────────────────────────────────────────────────

export interface ToolMon {
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  sp?: MonInput['sp'];
}
export interface CalcDamageArgs {
  attacker: ToolMon;
  defender: ToolMon;
  moveName: string;
  gameType?: string;
  weather?: string;
  terrain?: string;
  isCrit?: boolean;
}
export interface LookupUsageArgs {
  species: string;
}
export interface CompareSpeedArgs {
  mons: {
    species: string;
    label?: string;
    nature?: string;
    item?: string;
    speSP?: number;
    stage?: number;
    paralyzed?: boolean;
    tailwind?: boolean;
  }[];
  trickRoom?: boolean;
}

// ─── Executors ─────────────────────────────────────────────────────────────────

export function executeCalcDamage(args: CalcDamageArgs): unknown {
  const toMon = (m: ToolMon): MonInput => ({
    species: m.species,
    ability: m.ability,
    item: m.item,
    nature: m.nature,
    sp: m.sp,
  });
  const move: MoveInput = { name: args.moveName, isCrit: args.isCrit };
  const field: FieldInput = {
    gameType: args.gameType === 'Singles' ? 'Singles' : 'Doubles',
    weather: args.weather || undefined,
    terrain: args.terrain || undefined,
  };
  try {
    return calcDamage(toMon(args.attacker), toMon(args.defender), move, field);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function executeCompareSpeed(args: CompareSpeedArgs): unknown {
  const raw = args.mons ?? [];
  if (raw.length < 2) return { error: 'Provide at least two Pokémon to compare.' };
  const mons: SpeedMonInput[] = raw.map((m) => ({
    species: m.species,
    label: m.label,
    nature: m.nature,
    item: m.item,
    sp: m.speSP != null ? { spe: Math.max(0, Math.min(32, Math.round(m.speSP))) } : undefined,
    stage: m.stage,
    paralyzed: m.paralyzed,
    tailwind: m.tailwind,
  }));
  try {
    return compareSpeed(mons, { trickRoom: args.trickRoom });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** "Ice 4x, Dragon 2x" — type matchups flattened to one line each for the tool result. */
function fmtMatchups(list: TypeMatchup[]): string | undefined {
  return list.length ? list.map((m) => `${m.type} ${m.multiplier}x`).join(', ') : undefined;
}

export async function executeLookupUsage(args: LookupUsageArgs, ruleset: RulesetId = DEFAULT_RULESET): Promise<unknown> {
  try {
    const [data, source] = await Promise.all([fetchUsage(args.species, ruleset), resolveUsageFormat(ruleset)]);
    if (!data) return { error: `No usage data found for "${args.species}" (usage source: ${source.format}).` };
    const megaForms = formsJson(data.species, data.items?.[0]?.name);
    return {
      species: data.species,
      ...(megaForms ? { megaForms } : {}),
      ...(source.fallbackFrom
        ? { dataCaveat: `Pikalytics has not published ${getRuleset(ruleset).short} data yet — these numbers are from the previous format (${source.format}). Additions new to ${getRuleset(ruleset).short} have no usage data; reason from mechanics.` }
        : {}),
      usagePct: data.usagePct || undefined,
      winRate: data.winRatePct != null ? `${data.winRatePct}%${data.record ? ` over ${data.record} (W-L-T)` : ''}` : undefined,
      topMoves: data.moves.slice(0, 6).map((e) => `${e.name} (${e.pct}%)`),
      // Cross-check against the dex whitelist: usage data should only contain legal items, so a
      // miss means parser drift or a renamed item — flag it rather than let it be proposed.
      topItems: data.items
        .slice(0, 4)
        .map((e) => `${e.name} (${e.pct}%)${isLegalItem(e.name, ruleset) ? '' : ' [NOT in the legal item list — do not propose]'}`),
      topAbilities: data.abilities.slice(0, 3).map((e) => `${e.name} (${e.pct}%)`),
      // Co-occurrence, not opinion: how often each species actually shares a team with this one.
      commonTeammates: data.teammates.slice(0, 6).map((e) => `${e.name} (${e.pct}%)`),
      topSpread: data.topSpread,
      // A spread Pikalytics has not computed for this regulation yet is borrowed from the previous
      // one; say so, the same way dataCaveat does for a whole-format fallback.
      topSpreadCaveat: data.topSpreadSource
        ? `This spread is from the previous format (${data.topSpreadSource}) — ${getRuleset(ruleset).short} has no spread data yet. Call it the previous regulation's spread, not the current one's.`
        : undefined,
      typeMatchups: data.typeMatchups
        ? {
            weakTo: fmtMatchups(data.typeMatchups.weakTo),
            resists: fmtMatchups(data.typeMatchups.resists),
            immuneTo: fmtMatchups(data.typeMatchups.immuneTo),
            abilityNote: data.typeMatchups.abilityNote,
          }
        : undefined,
      featuredSets: data.sets.slice(0, 3).map((s) => ({
        label: s.label,
        event: s.event,
        ability: s.ability,
        item: s.item,
        nature: s.nature,
        sp: s.sp,
        moves: s.moves,
        team: s.members.length ? s.members.join(', ') : undefined,
      })),
      // Compositions only for the rest of the featured teams — real tournament teams built around
      // this Pokémon, which is the evidence for synergy questions. Capped so the result stays small.
      moreFeaturedTeams: data.sets
        .slice(3, 8)
        .filter((s) => s.members.length)
        .map((s) => `${s.label}: ${s.members.join(', ')}`),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Dispatch for the engine/data tools every AI caller shares. Returns undefined for other names. */
export async function executeSharedTool(name: string, args: unknown, ruleset: RulesetId = DEFAULT_RULESET): Promise<unknown | undefined> {
  if (name === 'calcDamage') return executeCalcDamage(args as CalcDamageArgs);
  if (name === 'lookupUsage') return executeLookupUsage(args as LookupUsageArgs, ruleset);
  if (name === 'compareSpeed') return executeCompareSpeed(args as CompareSpeedArgs);
  if (name === 'threatMatrix') return executeThreatMatrix(args as ThreatMatrixArgs, ruleset);
  return undefined;
}

// ─── Legality gate ─────────────────────────────────────────────────────────────

/**
 * Server-side legality gate for AI-proposed sets: dex legality (species/item/moves), per-species
 * ability, species↔move learnsets (Gen 9 graft), and the SP budget. Errors go back to the model
 * instead of the action being pushed, so the model self-corrects and the user never sees an
 * illegal set.
 */
export async function validateProposal(
  species: string,
  set: { ability?: string; item?: string; moves?: string[]; sp?: SpSpread },
  ruleset: RulesetId = DEFAULT_RULESET,
): Promise<string[]> {
  const moves = set.moves?.filter(Boolean);
  const errors = validateLegality({
    species,
    item: set.item || undefined,
    moves,
  }, ruleset).map((i) => i.message);
  if (isMegaSpecies(species)) {
    const stone = stoneForMega(species);
    if (stone && (set.item ?? '').toLowerCase() !== stone.toLowerCase()) {
      errors.push(`${species} must hold ${stone} to Mega Evolve (it has ${set.item || 'no item'}). Give it ${stone}, or use the base forme.`);
    }
  } else {
    const forms = megaFormsFor(species, set.item);
    if (forms && isLegalSpecies(forms.mega, ruleset)) {
      errors.push(`${species} holding ${forms.stone} Mega Evolves into ${forms.mega} — propose it as "${forms.mega}" so its Mega stats, typing, and ability are the ones judged.`);
    }
  }
  if (set.ability) {
    const legal = legalAbilities(species);
    if (legal.length && !legal.some((a) => a.toLowerCase() === set.ability!.toLowerCase())) {
      errors.push(`${set.ability} is not a legal ability for ${species}. Legal abilities: ${legal.join(', ')}.`);
    }
  }
  if (moves?.length && isLegalSpecies(species, ruleset)) {
    errors.push(...(await learnsetIssues(species, moves, ruleset)));
  }
  if (set.sp) {
    const v = validateSp(set.sp);
    if (!v.ok) errors.push(...v.errors);
  }
  return errors;
}

// ─── Set construction from usage data ──────────────────────────────────────────

export interface SetOverrides {
  ability?: string;
  item?: string;
  nature?: string;
  moves?: string[];
  sp?: SpSpread;
}

/**
 * Build a complete set for a species, filling anything the caller did not specify from the most
 * common Pikalytics data (featured set first, then top moves/items/abilities, then topSpread).
 * Falls back to empty strings / a neutral nature when there is no usage data.
 */
export async function buildSetFromUsage(species: string, overrides: SetOverrides = {}, ruleset: RulesetId = DEFAULT_RULESET): Promise<CalcMonSet> {
  const usage = await fetchUsage(species, ruleset).catch(() => null);
  const featured = usage?.sets?.[0];
  const movesRaw =
    overrides.moves?.filter(Boolean).length
      ? overrides.moves.filter(Boolean)
      : featured?.moves?.length
        ? featured.moves
        : (usage?.moves?.slice(0, 4).map((e) => e.name) ?? []);
  const sp = (overrides.sp as SpSpread | undefined) ?? (featured?.sp as SpSpread | undefined) ?? (usage?.topSpread as SpSpread | undefined) ?? {};
  const item = overrides.item ?? featured?.item ?? usage?.items?.[0]?.name ?? '';
  // Usage lists the species you bring ("Charizard" holding Charizardite X); the set is the forme it
  // fights as, so the engine and every judgment see the Mega's stats, typing, and ability.
  const forme = calcSpecies(species, item, ruleset);
  const abilities = forme !== species ? (getSpecies(forme)?.abilities ?? []) : [];
  return {
    species: forme,
    ability: (forme !== species ? abilities[0] : undefined) ?? overrides.ability ?? featured?.ability ?? usage?.abilities?.[0]?.name ?? '',
    item,
    nature: overrides.nature ?? featured?.nature ?? 'Hardy',
    sp,
    moves: movesRaw.slice(0, 4),
  };
}

// ─── Generic tool loop ─────────────────────────────────────────────────────────

export interface ToolInvocation {
  name: string;
  args: unknown;
  result: unknown;
}

/**
 * Run a function-calling loop on any provider until the model answers with text (or `stopWhen`
 * says the caller has what it needs). `dispatch` executes one tool call; the shared engine tools
 * are handled automatically before it is consulted. `messages` is mutated in place so callers can
 * inspect the transcript afterwards.
 */
export async function runToolLoop(opts: {
  client: LlmClient;
  system: string;
  messages: LlmMessage[];
  declarations: FunctionDeclaration[];
  dispatch: (name: string, args: unknown) => Promise<unknown>;
  maxRounds: number;
  /** Return true once the loop should stop (e.g. a terminal tool succeeded). */
  stopWhen?: () => boolean;
  /** Ruleset the shared tools should answer for (usage source, item legality). */
  ruleset?: RulesetId;
}): Promise<{ text: string; toolCalls: ToolInvocation[]; exhausted: boolean }> {
  const toolCalls: ToolInvocation[] = [];
  const { messages } = opts;
  for (let round = 0; round < opts.maxRounds; round++) {
    const resp = await opts.client.generate({ system: opts.system, messages, tools: opts.declarations });
    if (resp.toolCalls.length === 0) {
      return { text: resp.text, toolCalls, exhausted: false };
    }
    messages.push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls, raw: resp.raw });
    const results = [];
    for (const call of resp.toolCalls) {
      let result = await executeSharedTool(call.name, call.args, opts.ruleset ?? DEFAULT_RULESET);
      if (result === undefined) result = await opts.dispatch(call.name, call.args);
      toolCalls.push({ name: call.name, args: call.args, result });
      results.push({ id: call.id, name: call.name, result });
    }
    messages.push({ role: 'tool', results });
    if (opts.stopWhen?.()) return { text: resp.text, toolCalls, exhausted: false };
  }
  return { text: '', toolCalls, exhausted: true };
}

/** One schema-constrained JSON reply, parsed; null when the model or the parse fails. */
export async function generateJson<T>(client: LlmClient, opts: { system: string; prompt: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<T | null> {
  try {
    const resp = await client.generate({ system: opts.system, messages: [{ role: 'user', text: opts.prompt }], jsonSchema: opts.schema, maxTokens: opts.maxTokens });
    const text = resp.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
