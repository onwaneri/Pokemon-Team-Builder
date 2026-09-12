/**
 * Agentic team builder, run one model round per request.
 *
 * Takes a loose description ("rain with a Trick Room mode", "something around Garchomp and
 * Incineroar") plus whatever the user already placed, and fills the remaining slots. The model
 * researches with the shared engine tools (lookupUsage for real sets and spreads, compareSpeed
 * for tiers, calcDamage for key benchmarks, threatMatrix to check the build against the live
 * rankings before submitting) and finishes by calling `submitTeam`. Every submitted
 * set goes through the same legality gate as chat proposals; errors are returned to the model so
 * it corrects and resubmits. Slots the user already filled are locked — the server keeps the
 * originals no matter what the model returns.
 *
 * A full build is 5–15 model rounds (30–90 s), longer than serverless request limits allow, so
 * the loop is split: `startBuild` prepares the state, `stepBuild` runs exactly one round, and the
 * route hands the (signed) state back to the browser between rounds. No request ever waits on
 * more than one model call plus its tools.
 *
 * Server-only.
 */
import { Type, type FunctionDeclaration } from '@google/genai';
import type { LlmClient, LlmMessage } from '@/lib/ai/llm';
import { fetchFormatRankings, resolveUsageFormat } from '@/lib/data/usage';
import { listItems, isLegalSpecies } from '@/lib/data/champions';
import { computeStats } from '@/lib/calc/engine';
import { championsMeta } from '@/lib/data/meta';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import type { TeamMon } from '@/lib/benchmarks/types';
import { ZERO_STATS, type SpSpread } from '@/lib/calc/sp';
import { padMoves } from '@/lib/moves';
import {
  calcDamageDeclaration,
  lookupUsageDeclaration,
  compareSpeedDeclaration,
  threatMatrixDeclaration,
  spSchema,
  validateProposal,
  buildSetFromUsage,
  executeSharedTool,
  fmtSp,
} from '@/lib/ai/tools';

const MAX_ROUNDS = 40;

export interface BuildTeamInput {
  prompt: string;
  team: (TeamMon | null)[];
  regulation?: RulesetId;
}

export interface BuildTeamResult {
  team: (TeamMon | null)[];
  summary: string;
  toolCalls: { name: string }[];
}

/** Everything a build needs between rounds. Serialized (and signed) by the route. */
export interface BuildState {
  v: 1;
  ruleset: RulesetId;
  system: string;
  messages: LlmMessage[];
  slots: (TeamMon | null)[];
  round: number;
  toolNames: string[];
}

export interface BuildStep {
  state: BuildState;
  /** One line for the UI: what this round did. */
  progress: string;
  /** Set on the round that produced an accepted team. */
  done: BuildTeamResult | null;
}

interface SubmittedSlot {
  slot: number;
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  moves?: string[];
  sp?: Record<string, number>;
  role?: string;
}
interface SubmitTeamArgs {
  slots: SubmittedSlot[];
  summary: string;
}

const submitTeamDeclaration: FunctionDeclaration = {
  name: 'submitTeam',
  description:
    'Submit the finished team. Include one entry per slot you are filling (never the locked slots). Each set must be complete: ability, item, nature, four moves, and an SP spread (0–32 per stat, ≤66 total). If validation errors come back, fix them and submit again.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slots: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            slot: { type: Type.NUMBER, description: 'Slot number (1–6).' },
            species: { type: Type.STRING, description: 'Exact engine species name, e.g. "Dragonite-Mega".' },
            ability: { type: Type.STRING },
            item: { type: Type.STRING },
            nature: { type: Type.STRING },
            moves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exactly 4 moves.' },
            sp: spSchema,
            role: { type: Type.STRING, description: 'One sentence: what this Pokémon does on the team.' },
          },
          required: ['slot', 'species', 'ability', 'item', 'nature', 'moves', 'sp', 'role'],
        },
      },
      summary: { type: Type.STRING, description: '2–3 sentences on how the finished team plays: archetype, win condition, speed-control plan.' },
    },
    required: ['slots', 'summary'],
  },
};

async function buildSystemInstruction(locked: TeamMon[], openSlots: number[], ruleset: RulesetId): Promise<string> {
  const rules = getRuleset(ruleset);
  const legalItems = listItems(ruleset);
  const [rankings, source] = await Promise.all([fetchFormatRankings(ruleset).catch(() => []), resolveUsageFormat(ruleset).catch(() => null)]);
  const sourceCaveat = source?.fallbackFrom
    ? `  NOTE: Pikalytics has not published ${rules.short} data yet — this is ${source.format} data. Pokémon new to ${rules.short} have no usage; judge them from the ruleset notes, typing, and stats, and still call lookupUsage (it may 404 for them — that is expected).\n`
    : '';
  const rankingsSection = sourceCaveat + (rankings.length
    ? rankings.slice(0, 30).map((r) => `  ${r.rank}. ${r.species}${r.winRatePct != null ? ` — ${r.winRatePct}% win rate${r.record ? ` over ${r.record}` : ''}` : ''}`).join('\n')
    : '  (rankings unavailable — rely on lookupUsage per species)');
  const lockedSection = locked.length
    ? locked.map((m) => `  Slot ${m.slot}: ${m.species} @ ${m.item || '—'} | ${m.ability || '—'} | ${m.nature} | ${m.moves.filter(Boolean).join('/') || 'no moves'} | SP ${fmtSp(m.sp)}`).join('\n')
    : '  (none — build the whole team)';

  return `${championsMeta(ruleset)}

You are building a Pokémon Champions (VGC doubles, ${rules.label}, Level 50, bring 4 of 6) team inside a team-building tool.

═══ RULES ═══
• Stat Points (SP): 0–32 per stat, 66 total. Never mention EVs/IVs. 1 SP ≈ 1 final stat point.
• No Terastallization.
• Mega Evolution: use exact hyphenated names ("Dragonite-Mega"). Only ONE Mega can evolve per battle, so
  carry at most one Mega unless the user explicitly asks for two options.
• Species Clause: no duplicate species. Item Clause: no duplicate items.
• LEGAL ITEMS (complete ${rules.short} whitelist): ${legalItems.join(', ')}.
• Every set is validated against the dex, per-species abilities, learnsets, and the SP budget. Fix and
  resubmit on error.

═══ LIVE USAGE (Pikalytics, format ${source?.format ?? rules.pikalyticsFormats[0]}) ═══
${rankingsSection}

═══ LOCKED SLOTS (already chosen by the user — keep them exactly, build around them) ═══
${lockedSection}

═══ SLOTS TO FILL ═══
${openSlots.join(', ')}

═══ PROCESS ═══
1. Read the user's description. Decide the archetype and the roles the open slots need (speed control,
   Fake Out / redirection support, a Mega, physical + special damage, answers to the top of the usage
   rankings). Respect any species, style, or constraint the user names.
2. Call lookupUsage for EVERY candidate you are considering IN ONE TURN (issue all the calls at once —
   they run in parallel), then base each set on real data: featured sets, top moves/items/abilities, and
   the topSpread for SP. Adjust only with a concrete reason. Aim to finish in 4–5 turns total: research,
   one or two checks, the coverage check in step 4, submit.
3. Use compareSpeed to confirm any speed relationship you rely on (e.g. "outspeeds base 100s"), and
   calcDamage for one or two key benchmarks if a spread decision hinges on them.
4. Before submitting, call threatMatrix on the sets the team's offence rests on to check the build
   actually covers the metagame — it calcs a set both ways against the top of the live rankings in
   one call. Fix a hole it exposes (a move, an item, a spread, a different Pokémon) or name it in
   the summary. Claim coverage only for what it showed you.
5. Call submitTeam once with every open slot filled. Each set needs 4 moves and an SP spread that sums to
   at most 66. Give each Pokémon a one-sentence role and write a 2–3 sentence summary.
Do not write a long essay; the summary field is the only prose the user sees.`;
}

function openSlotsOf(slots: (TeamMon | null)[]): number[] {
  return slots.map((m, i) => (m ? null : i + 1)).filter((n): n is number => n !== null);
}

/** Validate a submitted team against the locked slots, the ruleset, and the clauses. */
async function verifySubmission(args: SubmitTeamArgs, slots: (TeamMon | null)[], ruleset: RulesetId): Promise<{ errors: string[]; built: TeamMon[]; summary: string }> {
  const locked = slots.filter((m): m is TeamMon => m !== null);
  const openSlots = openSlotsOf(slots);
  const errors: string[] = [];
  const proposed = (args.slots ?? []).filter((s) => openSlots.includes(s.slot));
  const missing = openSlots.filter((n) => !proposed.some((s) => s.slot === n));
  if (missing.length) errors.push(`Missing sets for slot(s) ${missing.join(', ')}.`);

  const seenSpecies = new Map<string, number>(locked.map((m) => [m.species.toLowerCase(), m.slot]));
  const seenItems = new Map<string, number>(locked.filter((m) => m.item).map((m) => [m.item!.toLowerCase(), m.slot]));
  const built: TeamMon[] = [];

  for (const s of proposed) {
    if (!isLegalSpecies(s.species, ruleset)) { errors.push(`Slot ${s.slot}: ${s.species} is not usable in ${getRuleset(ruleset).short}.`); continue; }
    const set = await buildSetFromUsage(s.species, {
      ability: s.ability,
      item: s.item,
      nature: s.nature,
      moves: s.moves,
      sp: s.sp as SpSpread | undefined,
    }, ruleset);
    const setErrors = await validateProposal(set.species, { ability: set.ability, item: set.item, moves: set.moves, sp: set.sp }, ruleset);
    errors.push(...setErrors.map((e) => `Slot ${s.slot}: ${e}`));
    if (set.moves.filter(Boolean).length < 4) errors.push(`Slot ${s.slot} (${set.species}): needs 4 moves, got ${set.moves.filter(Boolean).length}.`);
    const dupSpecies = seenSpecies.get(set.species.toLowerCase());
    if (dupSpecies !== undefined) errors.push(`Slot ${s.slot}: ${set.species} is already in slot ${dupSpecies} (Species Clause).`);
    else seenSpecies.set(set.species.toLowerCase(), s.slot);
    if (set.item) {
      const dupItem = seenItems.get(set.item.toLowerCase());
      if (dupItem !== undefined) errors.push(`Slot ${s.slot}: ${set.item} is already held by slot ${dupItem} (Item Clause).`);
      else seenItems.set(set.item.toLowerCase(), s.slot);
    }

    let computedStats = ZERO_STATS;
    try {
      computedStats = computeStats({ species: set.species, ability: set.ability, item: set.item, nature: set.nature, sp: set.sp });
    } catch (e) {
      errors.push(`Slot ${s.slot}: ${(e as Error).message}`);
    }
    built.push({
      slot: s.slot,
      nickname: null,
      species: set.species,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      sp: set.sp,
      moves: padMoves(set.moves),
      computedStats,
      role: (s.role ?? '').trim(),
      benchmarks: [],
    });
  }
  return { errors, built, summary: (args.summary ?? '').trim() };
}

const DECLARATIONS = [lookupUsageDeclaration, compareSpeedDeclaration, calcDamageDeclaration, threatMatrixDeclaration, submitTeamDeclaration];

/** Prepare a build: locks the filled slots and writes the system prompt. Runs no model call. */
export async function startBuild(input: BuildTeamInput): Promise<BuildState> {
  const slots: (TeamMon | null)[] = Array(6).fill(null);
  for (const m of input.team) if (m && m.slot >= 1 && m.slot <= 6) slots[m.slot - 1] = m;
  const locked = slots.filter((m): m is TeamMon => m !== null);
  const openSlots = openSlotsOf(slots);
  if (!openSlots.length) throw new Error('The team is already full.');
  const ruleset = input.regulation ?? DEFAULT_RULESET;
  const system = await buildSystemInstruction(locked, openSlots, ruleset);
  return {
    v: 1,
    ruleset,
    system,
    messages: [{ role: 'user', text: input.prompt.trim() || 'Build the strongest, most standard team you can for the current metagame.' }],
    slots,
    round: 0,
    toolNames: [],
  };
}

function describeRound(calls: { name: string; args: unknown }[]): string {
  const species = (c: { args: unknown }) => (c.args as { species?: string })?.species;
  const looked = calls.filter((c) => c.name === 'lookupUsage').map(species).filter(Boolean) as string[];
  const parts: string[] = [];
  if (looked.length) parts.push(`looked up ${looked.slice(0, 4).join(', ')}${looked.length > 4 ? ` +${looked.length - 4}` : ''}`);
  const speed = calls.filter((c) => c.name === 'compareSpeed').length;
  if (speed) parts.push(`checked ${speed} speed matchup${speed > 1 ? 's' : ''}`);
  const dmg = calls.filter((c) => c.name === 'calcDamage').length;
  if (dmg) parts.push(`ran ${dmg} damage calc${dmg > 1 ? 's' : ''}`);
  if (calls.some((c) => c.name === 'submitTeam')) parts.push('validating the team');
  return parts.length ? parts.join(' · ') : 'thinking';
}

/**
 * Run exactly one model round: generate, execute every tool call (in parallel), append the
 * results. Returns the accepted team on the round that passes verification.
 */
export async function stepBuild(client: LlmClient, state: BuildState): Promise<BuildStep> {
  if (state.round >= MAX_ROUNDS) {
    throw new Error('The builder ran out of steps before finishing a legal team. Try a more specific description.');
  }
  const resp = await client.generate({ system: state.system, messages: state.messages, tools: DECLARATIONS });
  if (resp.toolCalls.length === 0) {
    throw new Error('The builder finished without submitting a team. Try again, or describe what you want more specifically.');
  }
  state.messages.push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls, raw: resp.raw });

  let accepted: { built: TeamMon[]; summary: string } | null = null;
  const results = await Promise.all(resp.toolCalls.map(async (call) => {
    let result = await executeSharedTool(call.name, call.args, state.ruleset);
    if (result === undefined) {
      if (call.name === 'submitTeam') {
        const v = await verifySubmission(call.args as unknown as SubmitTeamArgs, state.slots, state.ruleset);
        if (v.errors.length) result = { error: `Team rejected — fix these and call submitTeam again:\n- ${v.errors.join('\n- ')}` };
        else { accepted = { built: v.built, summary: v.summary }; result = { status: 'ok', message: 'Team accepted.' }; }
      } else {
        result = { error: `Unknown tool: ${call.name}` };
      }
    }
    return { id: call.id, name: call.name, result };
  }));
  state.messages.push({ role: 'tool', results });
  state.round += 1;
  state.toolNames.push(...resp.toolCalls.map((c) => c.name));

  const progress = describeRound(resp.toolCalls);
  if (!accepted) return { state, progress, done: null };
  const { built, summary } = accepted as { built: TeamMon[]; summary: string };
  const team = [...state.slots];
  for (const m of built) team[m.slot - 1] = m;
  return { state, progress: 'team accepted', done: { team, summary, toolCalls: state.toolNames.map((name) => ({ name })) } };
}

/** Convenience for non-HTTP callers (tests, scripts): run steps until done. */
export async function buildTeam(client: LlmClient, input: BuildTeamInput): Promise<BuildTeamResult> {
  let state = await startBuild(input);
  for (;;) {
    const step = await stepBuild(client, state);
    if (step.done) return step.done;
    state = step.state;
  }
}
