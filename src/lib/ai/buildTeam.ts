/**
 * Team builder as a fixed pipeline of bounded phases, one phase per request.
 *
 * The earlier design was an open-ended agent loop: the model decided how many tool calls to make
 * and how much to emit per round, so a round's duration was whatever the model felt like, and the
 * only protection was killing it. This version fixes the shape of the work up front so every
 * request has a known ceiling and the build can always finish:
 *
 *   plan    — ONE schema-constrained model call (small output): archetype, which species fill the
 *             open slots, alternates. Validated deterministically; illegal or duplicate picks are
 *             swapped for alternates, then for top-ranked species. No model → top-ranked fallback.
 *   draft   — NO model. Usage data for the picks (parallel, each fetch capped), legal default sets
 *             built and validated from it, item clause enforced, plus an engine-computed evidence
 *             pack: every draft's Speed and a coverage table against the top of the rankings
 *             (calcDamage both ways). A pick with no usable data is replaced by an alternate.
 *   refine  — ONE schema-constrained model call: given the drafts and the evidence, choose moves,
 *             item, ability, nature, SP, and a role per slot, plus a summary. Every refined slot
 *             is validated; a slot that fails keeps its draft, which is legal by construction. No
 *             model → the drafts ship as the team.
 *
 * Each phase is one HTTP request (the route hands the signed state back between them), and each
 * is bounded by exactly one dominant cost: a single capped model call (LLM_TIMEOUT_MS) or a batch
 * of capped fetches. There is no loop the model controls and no path that ends without a legal
 * team.
 *
 * Server-only.
 */
import type { LlmClient } from '@/lib/ai/llm';
import { fetchFormatRankings, fetchUsage, resolveUsageFormat, type UsageData, type UsageRank } from '@/lib/data/usage';
import { listItems, listSpecies, isLegalSpecies, getSpecies, getMove } from '@/lib/data/champions';
import { megaForStone } from '@/lib/data/megas';
import { calcDamage, computeStats, type CalcResult } from '@/lib/calc/engine';
import { championsMeta } from '@/lib/data/meta';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import type { TeamMon } from '@/lib/benchmarks/types';
import { ZERO_STATS, validateSp, type SpSpread } from '@/lib/calc/sp';
import { padMoves } from '@/lib/moves';
import type { CalcMonSet } from '@/lib/ai/types';
import { validateProposal, buildSetFromUsage, generateJson, fmtSp } from '@/lib/ai/tools';

// ─── Budgets (the whole point of this file) ─────────────────────────────────────

/** Top of the rankings the planner may choose from. */
const CANDIDATE_POOL = 30;
/** Threats every draft is measured against in the evidence pack. */
const THREAT_COUNT = 8;
/** Alternates the planner must supply so deterministic substitution has material. */
const ALTERNATES = 4;
/** Output caps: the planner is a short list; the refiner is six sets and three sentences. */
const PLAN_MAX_TOKENS = 900;
const REFINE_MAX_TOKENS = 2600;

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

export type BuildPhase = 'plan' | 'draft' | 'refine';

interface DraftSet extends CalcMonSet {
  slot: number;
  /** Why the planner picked it (carried into the refine prompt and the fallback role). */
  role: string;
  /** Compact usage evidence for the refiner. */
  evidence: string;
}

/** Everything a build needs between phases. Serialized (and signed) by the route. */
export interface BuildState {
  v: 2;
  ruleset: RulesetId;
  prompt: string;
  slots: (TeamMon | null)[];
  phase: BuildPhase;
  /** Phase counter, kept for the route/panel (`round`). */
  round: number;
  /** Written by `plan`. */
  archetype?: string;
  plan?: string;
  picks?: { slot: number; species: string; role: string }[];
  alternates?: string[];
  /** Written by `draft`. */
  drafts?: DraftSet[];
  evidence?: string;
  /** Which phases ran on the model vs. fell back, for the UI's "what happened" line. */
  notes: string[];
}

export interface BuildStep {
  state: BuildState;
  /** One line for the UI: what this phase did. */
  progress: string;
  /** Set on the phase that produced the team. */
  done: BuildTeamResult | null;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

function openSlotsOf(slots: (TeamMon | null)[]): number[] {
  return slots.map((m, i) => (m ? null : i + 1)).filter((n): n is number => n !== null);
}

const isMega = (s: string) => /-Mega(-[XYZ])?$/.test(s);

/**
 * KO tier from the engine's own rolls: "OHKO" only when the minimum roll does it, "OHKO (roll)"
 * when only the maximum does; likewise for 2HKO / 3HKO+. Arithmetic only, no heuristics.
 */
function koLabel(r: CalcResult): string {
  const hp = r.defenderMaxHP;
  if (!hp || r.maxDamage <= 0) return 'no damage';
  const best = Math.ceil(hp / r.maxDamage);
  const worst = r.minDamage > 0 ? Math.ceil(hp / r.minDamage) : Infinity;
  const tier = best <= 1 ? 'OHKO' : best === 2 ? '2HKO' : best <= 4 ? '3HKO+' : 'negligible';
  return tier === 'negligible' || worst <= best ? tier : `${tier} (roll)`;
}

/**
 * Which attacking stat a set actually uses: decided by its damaging moves' categories (a Torkoal
 * with Eruption/Weather Ball is special no matter that its base Atk equals its base SpA), then by
 * the spread, then by base stats.
 */
function attackingStat(species: string, moves: string[], sp: SpSpread): 'atk' | 'spa' {
  let physical = 0;
  let special = 0;
  for (const mv of moves) {
    const info = mv ? getMove(mv) : null;
    if (info?.category === 'Physical' && info.basePower > 0) physical += 1;
    else if (info?.category === 'Special' && info.basePower > 0) special += 1;
  }
  if (physical !== special) return physical > special ? 'atk' : 'spa';
  if ((sp.atk ?? 0) !== (sp.spa ?? 0)) return (sp.atk ?? 0) > (sp.spa ?? 0) ? 'atk' : 'spa';
  const base = getSpecies(species)?.baseStats;
  return base && base.spa > base.atk ? 'spa' : 'atk';
}

/**
 * Usage data carries spreads but rarely natures, so drafts arrive as "Hardy". A neutral nature on
 * an invested attacker is a real downgrade, so derive one from what the set attacks with and how
 * it is invested: boost the attacking stat (or Spe when Speed is the largest investment), drop
 * the unused attacking stat, or pick a bulk nature for defensive spreads.
 */
function inferNature(species: string, moves: string[], sp: SpSpread, current: string): string {
  if (current && current.toLowerCase() !== 'hardy') return current;
  const physical = attackingStat(species, moves, sp) === 'atk';
  const speedFirst = (sp.spe ?? 0) >= 24 && (sp.spe ?? 0) >= Math.max(sp.atk ?? 0, sp.spa ?? 0);
  const bulkFirst = (sp.hp ?? 0) + (sp.def ?? 0) + (sp.spd ?? 0) >= 48 && Math.max(sp.atk ?? 0, sp.spa ?? 0) < 16;
  if (bulkFirst) return (sp.def ?? 0) >= (sp.spd ?? 0) ? (physical ? 'Impish' : 'Bold') : (physical ? 'Careful' : 'Calm');
  if (speedFirst) return physical ? 'Jolly' : 'Timid';
  return physical ? 'Adamant' : 'Modest';
}

/** A sane default spread when usage has none: max the attacking stat the moves use, then Speed or bulk. */
function defaultSpread(species: string, moves: string[]): SpSpread {
  const base = getSpecies(species)?.baseStats;
  const attacking = attackingStat(species, moves, {});
  if (!base) return { hp: 32, [attacking]: 32, spe: 2 };
  return base.spe >= 85 ? { hp: 2, [attacking]: 32, spe: 32 } : { hp: 32, [attacking]: 32, spd: 2 };
}

/** Case/apostrophe-insensitive species resolution ("farfetch'd", "Mega Charizard Y" → dex name). */
function resolveSpecies(name: string, ruleset: RulesetId): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[’'.\s-]/g, '');
  const all = listSpecies(ruleset);
  if (all.includes(name)) return name;
  const target = norm(name).replace(/^mega(.+?)([xyz])?$/, (_, base: string, suffix?: string) => `${base}mega${suffix ?? ''}`);
  return all.find((s) => norm(s) === target || norm(s) === norm(name)) ?? null;
}

function rankingsSection(rankings: UsageRank[], fallbackFrom: string | null, format: string, ruleset: RulesetId): string {
  const rules = getRuleset(ruleset);
  const caveat = fallbackFrom
    ? `NOTE: Pikalytics has not published ${rules.short} data yet — this is ${format} data. Pokémon new to ${rules.short} (see the ruleset notes) have no usage yet; judge them from mechanics.\n`
    : '';
  const rows = rankings.slice(0, CANDIDATE_POOL).map((r) => `${r.rank}. ${r.species}${r.winRatePct != null ? ` (${r.winRatePct}% WR)` : ''}`).join('\n');
  return caveat + (rows || '(rankings unavailable)');
}

function lockedSection(locked: TeamMon[]): string {
  return locked.length
    ? locked.map((m) => `Slot ${m.slot}: ${m.species} @ ${m.item || '—'} | ${m.ability || '—'} | ${m.nature} | ${m.moves.filter(Boolean).join('/') || 'no moves'} | SP ${fmtSp(m.sp)}`).join('\n')
    : '(none — build the whole team)';
}

function toMon(set: CalcMonSet & { slot: number; role: string }): TeamMon {
  let computedStats = ZERO_STATS;
  try {
    computedStats = computeStats({ species: set.species, ability: set.ability, item: set.item, nature: set.nature, sp: set.sp });
  } catch { /* stays ZERO_STATS; validation already passed, so this is defensive */ }
  return {
    slot: set.slot,
    nickname: null,
    species: set.species,
    item: set.item,
    ability: set.ability,
    nature: set.nature,
    sp: set.sp,
    moves: padMoves(set.moves),
    computedStats,
    role: set.role.trim(),
    benchmarks: [],
  };
}

// ─── Phase 0: start (no model) ─────────────────────────────────────────────────

export async function startBuild(input: BuildTeamInput): Promise<BuildState> {
  const slots: (TeamMon | null)[] = Array(6).fill(null);
  for (const m of input.team) if (m && m.slot >= 1 && m.slot <= 6) slots[m.slot - 1] = m;
  if (!openSlotsOf(slots).length) throw new Error('The team is already full.');
  return {
    v: 2,
    ruleset: input.regulation ?? DEFAULT_RULESET,
    prompt: input.prompt.trim() || 'Build the strongest, most standard team you can for the current metagame.',
    slots,
    phase: 'plan',
    round: 0,
    notes: [],
  };
}

// ─── Phase 1: plan (one bounded model call) ────────────────────────────────────

interface PlanOutput {
  archetype: string;
  plan: string;
  picks: { slot: number; species: string; role: string }[];
  alternates: string[];
}

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    archetype: { type: 'STRING', description: 'Two to four words, e.g. "Sun + Trick Room", "Rain offense", "Goodstuffs balance".' },
    plan: { type: 'STRING', description: 'One or two sentences: the game plan and the roles the open slots cover.' },
    picks: {
      type: 'ARRAY',
      description: 'Exactly one entry per OPEN slot number given in the prompt.',
      items: {
        type: 'OBJECT',
        properties: {
          slot: { type: 'NUMBER' },
          species: { type: 'STRING', description: 'Exact species name from the candidate list or the ruleset notes.' },
          role: { type: 'STRING', description: 'One short sentence: what it does on this team.' },
        },
        required: ['slot', 'species', 'role'],
      },
    },
    alternates: { type: 'ARRAY', items: { type: 'STRING' }, description: `${ALTERNATES} backup species, best first, used if a pick turns out illegal or has no data.` },
  },
  required: ['archetype', 'plan', 'picks', 'alternates'],
};

async function runPlan(client: LlmClient | null, state: BuildState): Promise<string> {
  const { ruleset, slots } = state;
  const rules = getRuleset(ruleset);
  const locked = slots.filter((m): m is TeamMon => m !== null);
  const open = openSlotsOf(slots);
  const [rankings, source] = await Promise.all([fetchFormatRankings(ruleset).catch(() => []), resolveUsageFormat(ruleset).catch(() => null)]);
  const lockedNames = new Set(locked.map((m) => m.species));

  let out: PlanOutput | null = null;
  if (client) {
    const system = `${championsMeta(ruleset)}

You plan Pokémon Champions (VGC doubles, ${rules.label}, Level 50, bring 4 of 6) teams. You choose WHICH Pokémon
fill the open slots; sets are built afterwards from real usage data, so do not describe moves or items.
Rules: exact species names (Megas are hyphenated: "Dragonite-Mega", "Charizard-Mega-Y"); Species Clause (no
duplicates, including the locked slots). A team may carry any number of Mega-capable Pokémon; only one Mega
Evolves per battle, so extra Megas are flexible options, not a problem. Cover: speed control, a Fake Out / redirection support,
physical and special damage, and answers to the top of the rankings. Respect every species, style, or
constraint the user names. Prefer the candidate list; a Pokémon outside it is fine if the user asks or the
ruleset notes make it clearly good.`;
    const prompt = `User's request: "${state.prompt}"

OPEN SLOTS TO FILL: ${open.join(', ')}
LOCKED SLOTS (keep, build around):
${lockedSection(locked)}

CANDIDATES (current usage rankings, format ${source?.format ?? rules.pikalyticsFormats[0]}):
${rankingsSection(rankings, source?.fallbackFrom ?? null, source?.format ?? '', ruleset)}

Return exactly ${open.length} picks (one per open slot) and ${ALTERNATES} alternates.`;
    out = await generateJson<PlanOutput>(client, { system, prompt, schema: PLAN_SCHEMA, maxTokens: PLAN_MAX_TOKENS });
  }

  // Deterministic validation + substitution. Everything below is guaranteed to end with one legal,
  // unique species per open slot.
  const used = new Set<string>(lockedNames);
  const accept = (raw: string): string | null => {
    const species = resolveSpecies(raw, ruleset);
    if (!species || !isLegalSpecies(species, ruleset) || used.has(species)) return null;
    used.add(species);
    return species;
  };
  const alternates: string[] = [];
  for (const a of out?.alternates ?? []) { const s = resolveSpecies(a, ruleset); if (s) alternates.push(s); }
  const ranked = rankings.map((r) => r.species).filter((s) => isLegalSpecies(s, ruleset));
  const pool = [...alternates, ...ranked];

  const picks: { slot: number; species: string; role: string }[] = [];
  const bySlot = new Map((out?.picks ?? []).map((p) => [p.slot, p]));
  let substituted = 0;
  for (const slot of open) {
    const p = bySlot.get(slot);
    let species = p ? accept(p.species) : null;
    let role = p?.role ?? '';
    if (!species) {
      for (const cand of pool) { species = accept(cand); if (species) break; }
      role = role || 'Filled from the top of the usage rankings.';
      substituted += 1;
    }
    if (!species) throw new Error('Could not find enough legal species to fill the team.');
    picks.push({ slot, species, role });
  }

  state.archetype = out?.archetype?.trim() || 'Goodstuffs';
  state.plan = out?.plan?.trim() || 'Built from the top of the current usage rankings.';
  state.picks = picks;
  state.alternates = pool.filter((s) => !used.has(s)).slice(0, ALTERNATES + 4);
  state.notes.push(out ? 'planned by the model' : 'planner unavailable — filled from the rankings');
  if (substituted) state.notes.push(`${substituted} pick${substituted > 1 ? 's' : ''} replaced (illegal or duplicate)`);
  state.phase = 'draft';
  return `${out ? state.archetype : 'fallback plan'}: ${picks.map((p) => p.species).join(', ')}`;
}

// ─── Phase 2: draft (no model; fetches + engine) ───────────────────────────────

function usageEvidence(u: UsageData | null): string {
  if (!u) return 'no usage data';
  const moves = u.moves.slice(0, 8).map((m) => `${m.name} ${m.pct}%`).join(', ');
  const items = u.items.slice(0, 4).map((i) => `${i.name} ${i.pct}%`).join(', ');
  const abilities = u.abilities.slice(0, 3).map((a) => `${a.name} ${a.pct}%`).join(', ');
  const spread = u.topSpread ? fmtSp(u.topSpread as SpSpread) : 'n/a';
  const featured = u.sets.slice(0, 2).map((s) => `${s.nature ?? '?'} @ ${s.item}: ${s.moves.join('/')}`).join(' | ');
  return `moves: ${moves} · items: ${items} · abilities: ${abilities} · top SP: ${spread}${featured ? ` · featured: ${featured}` : ''}`;
}

/**
 * Build a validated default set; null when usage gives nothing legal to stand on.
 * A base species drafted with its Mega Stone becomes the Mega forme, which is what the engine
 * calcs with. Teams may carry any number of Megas (only one Mega Evolves per battle), so nothing
 * here limits them.
 */
async function draftFor(slot: number, species: string, role: string, ruleset: RulesetId, takenItems: Set<string>): Promise<DraftSet | null> {
  const usage = await fetchUsage(species, ruleset).catch(() => null);
  const set = await buildSetFromUsage(species, {}, ruleset);
  if (set.moves.filter(Boolean).length < 4) return null;
  const legal = new Set(listItems(ruleset).map((i) => i.toLowerCase()));
  const nextItem = () => (usage?.items ?? []).map((i) => i.name).find((i) => legal.has(i.toLowerCase()) && !takenItems.has(i.toLowerCase())) ?? '';
  const stoneMega = megaForStone(set.item);
  if (stoneMega && !isMega(set.species)) {
    if (isLegalSpecies(stoneMega, ruleset)) set.species = stoneMega;
    else set.item = nextItem();
  }
  // Item Clause: slide down the usage list for a free item.
  if (set.item && takenItems.has(set.item.toLowerCase())) set.item = nextItem();
  if (!Object.keys(set.sp).length) set.sp = defaultSpread(set.species, set.moves);
  set.nature = inferNature(set.species, set.moves, set.sp, set.nature);
  const errors = await validateProposal(set.species, { ability: set.ability, item: set.item, moves: set.moves, sp: set.sp }, ruleset);
  if (errors.length) return null;
  if (set.item) takenItems.add(set.item.toLowerCase());
  return { ...set, slot, role, evidence: usageEvidence(usage) };
}

/** Engine-computed facts for the refiner: Speeds and a coverage table against the top threats. */
async function evidencePack(drafts: DraftSet[], locked: TeamMon[], ruleset: RulesetId): Promise<string> {
  const teamSpecies = new Set([...drafts, ...locked].map((m) => m.species));
  const rankings = await fetchFormatRankings(ruleset).catch(() => []);
  const threatNames = rankings.map((r) => r.species).filter((s) => isLegalSpecies(s, ruleset) && !teamSpecies.has(s)).slice(0, THREAT_COUNT);
  const threats = (await Promise.all(threatNames.map(async (s) => {
    try { const set = await buildSetFromUsage(s, {}, ruleset); return set.moves.filter(Boolean).length ? set : null; } catch { return null; }
  }))).filter((s): s is CalcMonSet => s !== null);

  const spe = (m: CalcMonSet) => { try { return computeStats({ species: m.species, ability: m.ability, item: m.item, nature: m.nature, sp: m.sp }).spe; } catch { return 0; } };
  const speedLines = [
    ...drafts.map((d) => `  ${d.species} (draft): ${spe(d)}`),
    ...locked.map((m) => `  ${m.species} (locked): ${m.computedStats.spe}`),
    ...threats.map((t) => `  ${t.species} (threat, top spread): ${spe(t)}`),
  ].join('\n');

  const best = (atk: CalcMonSet, def: CalcMonSet): string | null => {
    let top: { move: string; label: string; max: number } | null = null;
    for (const mv of atk.moves.filter(Boolean)) {
      try {
        const r = calcDamage(
          { species: atk.species, ability: atk.ability, item: atk.item, nature: atk.nature, sp: atk.sp },
          { species: def.species, ability: def.ability, item: def.item, nature: def.nature, sp: def.sp },
          { name: mv },
          { gameType: 'Doubles' },
        );
        if (!r.rolls.length || r.maxDamage === 0) continue;
        if (!top || r.maxPct > top.max) top = { move: mv, label: koLabel(r), max: r.maxPct };
      } catch { /* status move or unknown to the engine — skip */ }
    }
    return top ? `${top.move} ${top.label}` : null;
  };
  const coverage = threats.map((t) => {
    const offense = drafts.map((d) => { const b = best(d, t); return b ? `${d.species} ${b}` : null; }).filter(Boolean).join('; ') || 'nothing lands cleanly';
    const defense = drafts.map((d) => { const b = best(t, d); return b ? `${d.species} takes ${b}` : null; }).filter(Boolean).join('; ');
    return `  vs ${t.species} (${t.item || '—'}): offense — ${offense}. Its best hits — ${defense || 'none'}.`;
  }).join('\n');

  return `SPEED (final stat, before modifiers):\n${speedLines}\n\nCOVERAGE vs the top ${threats.length} threats (engine calcs, top usage sets, best move each way; KO tiers are engine-derived):\n${coverage}`;
}

async function runDraft(state: BuildState): Promise<string> {
  const { ruleset, slots } = state;
  const locked = slots.filter((m): m is TeamMon => m !== null);
  const takenItems = new Set(locked.map((m) => (m.item ?? '').toLowerCase()).filter(Boolean));
  const picks = state.picks ?? [];
  const alternates = [...(state.alternates ?? [])];
  const used = new Set([...locked.map((m) => m.species), ...picks.map((p) => p.species)]);

  // Drafts are built in slot order so Item Clause resolution is deterministic.
  const drafts: DraftSet[] = [];
  let replaced = 0;
  for (const p of picks) {
    let d = await draftFor(p.slot, p.species, p.role, ruleset, takenItems);
    while (!d && alternates.length) {
      const alt = alternates.shift()!;
      if (used.has(alt)) continue;
      d = await draftFor(p.slot, alt, `Replaces ${p.species}, which had no usable set. ${p.role}`, ruleset, takenItems);
      if (d) { used.add(alt); replaced += 1; }
    }
    if (!d) throw new Error(`No usable set could be built for slot ${p.slot} (${p.species}) or any alternate.`);
    drafts.push(d);
  }
  state.drafts = drafts;
  state.evidence = await evidencePack(drafts, locked, ruleset);
  if (replaced) state.notes.push(`${replaced} pick${replaced > 1 ? 's' : ''} swapped for an alternate (no usable usage data)`);
  state.phase = 'refine';
  return `drafted ${drafts.map((d) => d.species).join(', ')} from usage · ran coverage calcs vs top ${THREAT_COUNT}`;
}

// ─── Phase 3: refine (one bounded model call) → finish ─────────────────────────

interface RefineOutput {
  slots: { slot: number; ability: string; item: string; nature: string; moves: string[]; sp: Record<string, number>; role: string }[];
  summary: string;
}

const REFINE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    slots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          slot: { type: 'NUMBER' },
          ability: { type: 'STRING' },
          item: { type: 'STRING' },
          nature: { type: 'STRING' },
          moves: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Exactly 4 moves.' },
          sp: { type: 'OBJECT', properties: { hp: { type: 'NUMBER' }, atk: { type: 'NUMBER' }, def: { type: 'NUMBER' }, spa: { type: 'NUMBER' }, spd: { type: 'NUMBER' }, spe: { type: 'NUMBER' } } },
          role: { type: 'STRING', description: 'One sentence: what this Pokémon does on the team.' },
        },
        required: ['slot', 'ability', 'item', 'nature', 'moves', 'sp', 'role'],
      },
    },
    summary: { type: 'STRING', description: '2–3 sentences: archetype, win condition, speed-control plan, and any known hole.' },
  },
  required: ['slots', 'summary'],
};

async function runRefine(client: LlmClient | null, state: BuildState): Promise<BuildTeamResult> {
  const { ruleset, slots } = state;
  const rules = getRuleset(ruleset);
  const locked = slots.filter((m): m is TeamMon => m !== null);
  const drafts = state.drafts ?? [];
  const legalItems = listItems(ruleset);

  let out: RefineOutput | null = null;
  if (client) {
    const system = `${championsMeta(ruleset)}

You finalize Pokémon Champions (VGC doubles, ${rules.label}, Level 50) sets. The species are fixed; you choose
each slot's moves, item, ability, nature, SP spread, and a one-sentence role, then write the team summary.
Rules: Stat Points 0–32 per stat, 66 total (never EVs/IVs). No Terastallization. Item Clause (no duplicate
items, including the locked slots). Megas: keep any Mega forme or Mega Stone as drafted; a team may carry
several (only one Mega Evolves per battle). Choose a real nature that fits each spread (Jolly/
Adamant, Timid/Modest, or a bulk nature); a neutral nature is a downgrade on an invested attacker.
Legal items only: ${legalItems.join(', ')}.
Stay close to the usage evidence unless the SPEED or COVERAGE facts give a concrete reason to deviate (a
speed benchmark to hit, a threat nothing on the team handles). A move outside the usage list is allowed only
if the Pokémon can learn it. Every set is validated afterwards; an invalid set silently reverts to its draft,
so be conservative. Base every claim in the summary on the facts below — no invented numbers.`;
    const prompt = `User's request: "${state.prompt}"
Archetype: ${state.archetype}. Plan: ${state.plan}

LOCKED SLOTS (unchangeable):
${lockedSection(locked)}

DRAFT SETS (built from usage; refine these):
${drafts.map((d) => `Slot ${d.slot}: ${d.species} @ ${d.item || '—'} | ${d.ability || '—'} | ${d.nature} | SP ${fmtSp(d.sp)} | ${d.moves.join('/')}
  role hint: ${d.role}
  usage: ${d.evidence}`).join('\n')}

ENGINE EVIDENCE:
${state.evidence ?? '(unavailable)'}

Return one entry per draft slot (${drafts.map((d) => d.slot).join(', ')}) and the summary.`;
    out = await generateJson<RefineOutput>(client, { system, prompt, schema: REFINE_SCHEMA, maxTokens: REFINE_MAX_TOKENS });
  }

  // Apply refinements slot by slot; anything that fails validation keeps the draft.
  const takenItems = new Set(locked.map((m) => (m.item ?? '').toLowerCase()).filter(Boolean));
  const finalSets: (CalcMonSet & { slot: number; role: string })[] = [];
  let reverted = 0;
  for (const d of drafts) {
    const r = out?.slots?.find((s) => s.slot === d.slot);
    let chosen: CalcMonSet & { slot: number; role: string } = { ...d };
    if (r) {
      const sp: SpSpread = {};
      for (const [k, v] of Object.entries(r.sp ?? {})) if (typeof v === 'number' && v > 0) (sp as Record<string, number>)[k] = Math.round(v);
      const candidate: CalcMonSet & { slot: number; role: string } = {
        slot: d.slot,
        species: d.species,
        ability: r.ability?.trim() || d.ability,
        item: r.item?.trim() ?? d.item,
        nature: r.nature?.trim() || d.nature,
        sp: Object.keys(sp).length ? sp : d.sp,
        moves: (r.moves ?? []).filter(Boolean).slice(0, 4),
        role: r.role?.trim() || d.role,
      };
      const errors = candidate.moves.length === 4 && validateSp(candidate.sp).ok
        ? await validateProposal(candidate.species, { ability: candidate.ability, item: candidate.item, moves: candidate.moves, sp: candidate.sp }, ruleset)
        : ['incomplete set'];
      const itemClash = !!candidate.item && takenItems.has(candidate.item.toLowerCase());
      if (!errors.length && !itemClash) chosen = candidate;
      else { chosen = { ...d, role: candidate.role }; reverted += 1; }
    }
    // A reverted draft's item can only clash with a refined item chosen earlier in this pass.
    if (chosen.item && takenItems.has(chosen.item.toLowerCase())) chosen = { ...chosen, item: '' };
    if (chosen.item) takenItems.add(chosen.item.toLowerCase());
    finalSets.push(chosen);
  }

  const team = [...slots];
  for (const s of finalSets) team[s.slot - 1] = toMon(s);
  const summary = out?.summary?.trim()
    || `${state.archetype}: ${state.plan} Sets are the most common usage builds for ${drafts.map((d) => d.species).join(', ')}.`;
  state.notes.push(out ? 'sets refined by the model' : 'refiner unavailable — usage default sets kept');
  if (reverted) state.notes.push(`${reverted} refined set${reverted > 1 ? 's' : ''} failed validation and kept the draft`);
  return { team, summary, toolCalls: state.notes.map((name) => ({ name })) };
}

// ─── Driver ────────────────────────────────────────────────────────────────────

/**
 * Run exactly one phase. `client` may be null when no model is available: every phase has a
 * deterministic fallback, so the build still completes with legal, usage-based sets.
 */
export async function stepBuild(client: LlmClient | null, state: BuildState): Promise<BuildStep> {
  if (state.v !== 2) throw new Error('The build state is from an older version. Start again.');
  let progress: string;
  let done: BuildTeamResult | null = null;
  if (state.phase === 'plan') progress = await runPlan(client, state);
  else if (state.phase === 'draft') progress = await runDraft(state);
  else { done = await runRefine(client, state); progress = 'team finished'; }
  state.round += 1;
  return { state, progress, done };
}

/** Convenience for non-HTTP callers (tests, scripts): run every phase. */
export async function buildTeam(client: LlmClient | null, input: BuildTeamInput): Promise<BuildTeamResult> {
  let state = await startBuild(input);
  for (;;) {
    const step = await stepBuild(client, state);
    if (step.done) return step.done;
    state = step.state;
  }
}
