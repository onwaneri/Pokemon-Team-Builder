/**
 * Gemini chat with function calling into the deterministic Champions engine.
 *
 * The model never produces a damage number itself — it calls `calcDamage`, the server runs the real
 * engine, and the result is fed back for the model to explain. This preserves the core guarantee:
 * every number comes from code. Server-only (the caller supplies the LLM client + the calc engine).
 *
 * Two kinds of UI tools:
 *   - propose*   → the user sees an accept/reject card (suggestions the user did not ask for).
 *   - direct     → applied immediately (navigateTo, updateCalc, updateSpeedTier, applyTeamEdit,
 *                  setTeamSlot, removeTeamSlot, reorderTeam, renameTeam). These exist so any
 *                  imperative natural-language request ("put Incineroar as the defender", "turn on
 *                  Trick Room", "give Garchomp a Life Orb") changes the screen without a round trip.
 * The current screen state is serialized into the system prompt so the model edits what is
 * actually on screen rather than guessing.
 */
import { Type, type FunctionDeclaration } from '@google/genai';
import type { LlmClient, LlmMessage } from '@/lib/ai/llm';
import { fetchFormatRankings, resolveUsageFormat } from '@/lib/data/usage';
import { listItems, isLegalSpecies } from '@/lib/data/champions';
import { describeForms } from '@/lib/data/megas';
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';
import { championsMeta } from '@/lib/data/meta';
import type { TeamMon } from '@/lib/benchmarks/types';
import type {
  ChatAction,
  CalcMonSet,
  ScreenContext,
  ProposeTeamEditAction,
  ProposeBenchmarkAction,
  ProposeSubstitutionAction,
  UpdateCalcAction,
  UpdateSpeedTierAction,
  SpeedOpponent,
  SpeedEntryPatch,
  WorkspaceView,
} from '@/lib/ai/types';
import type { SpSpread } from '@/lib/calc/sp';
import {
  calcDamageDeclaration,
  lookupUsageDeclaration,
  compareSpeedDeclaration,
  threatMatrixDeclaration,
  spSchema,
  validateProposal,
  buildSetFromUsage,
  runToolLoop,
  fmtSp,
  type ToolInvocation,
} from '@/lib/ai/tools';

const MAX_TOOL_ROUNDS = 32;

const VIEW_LABEL: Record<WorkspaceView, string> = { team: 'Team', calc: 'Damage Calc', speed: 'Speed Tiers' };

function fmtSet(s: CalcMonSet): string {
  const forms = describeForms(s.species, s.item);
  return `${s.species} @ ${s.item || '—'} | ${s.ability || '—'} | ${s.nature || 'Hardy'} | SP ${fmtSp(s.sp)} | ${s.moves.filter(Boolean).join('/') || 'no moves'}${forms ? ` | ${forms}` : ''}`;
}

function describeScreen(context: ScreenContext | undefined, team: TeamMon[] | undefined): string {
  if (!context) return 'Screen state unavailable — use setupDamageCalc / setupSpeedTier to populate screens.';
  const { calc, speed } = context;
  const bySlot = new Map((team ?? []).map((m) => [m.slot, m]));
  const entries = speed.entries.length
    ? speed.entries
        .map((e) => {
          const mods = [
            e.stage ? `stage ${e.stage > 0 ? '+' : ''}${e.stage}` : null,
            e.paralyzed ? 'paralyzed' : null,
            e.scarf ? 'Choice Scarf' : null,
            e.priority ? `priority ${e.priority > 0 ? '+' : ''}${e.priority}` : null,
          ].filter(Boolean);
          const who = e.teamSlot != null
            ? `MINE slot ${e.teamSlot} ${bySlot.get(e.teamSlot)?.species ?? e.species}`
            : `OPP ${e.species} (${e.nature}, Spe SP ${e.speSP})`;
          return `  - ${who}${mods.length ? ` [${mods.join(', ')}]` : ''}`;
        })
        .join('\n')
    : '  (empty)';
  const onOff = (b: boolean) => (b ? 'ON' : 'off');
  return `Active tab: ${VIEW_LABEL[context.view]}. Team name: "${context.teamName}".

Damage Calc screen:
  Attacker: ${fmtSet(calc.attacker)}
  Defender: ${fmtSet(calc.defender)}
  Field: ${calc.field.gameType}, weather ${calc.field.weather || '—'}, terrain ${calc.field.terrain || '—'}, crit ${onOff(calc.field.isCrit)}

Speed Tiers screen:
  Tailwind (mine) ${onOff(speed.tailwindMine)}, Tailwind (opp) ${onOff(speed.tailwindOpp)}, Trick Room ${onOff(speed.trickRoom)}, priority brackets ${onOff(speed.showPriority)}
  Entries:
${entries}`;
}

async function buildSystemInstruction(team: TeamMon[] | undefined, context: ScreenContext | undefined, ruleset: RulesetId): Promise<string> {
  const rules = getRuleset(ruleset);
  // The complete item whitelist for this ruleset (gen-0 dex + ruleset delta). Injected into the prompt
  // so item legality is never asserted from model memory (the data, not intuition, decides what's banned).
  const legalItems = listItems(ruleset);
  // Live top-of-meta rankings so "what's common" comes from current Pikalytics data, not training data.
  const [rankings, source] = await Promise.all([fetchFormatRankings(ruleset).catch(() => []), resolveUsageFormat(ruleset).catch(() => null)]);
  const sourceCaveat = source?.fallbackFrom
    ? `\nNOTE: Pikalytics has not published ${rules.short} data yet — these rankings and every lookupUsage result are from the previous format (${source.format}). Pokémon new to ${rules.short} have no usage data; reason about them from typing, stats, and the ruleset notes.`
    : '';
  const rankingsSection = rankings.length
    ? `Top of the current usage rankings (live Pikalytics data, format ${source?.format ?? rules.pikalyticsFormats[0]} — weigh win rates by their W-L-T sample size):${sourceCaveat}\n${rankings
        .slice(0, 20)
        .map((r) => {
          const usage = r.usagePct != null ? `${r.usagePct}% usage` : null;
          const win = r.winRatePct != null ? `${r.winRatePct}% win rate${r.record ? ` over ${r.record}` : ''}` : null;
          return `  ${r.rank}. ${r.species}${usage || win ? ` — ${[usage, win].filter(Boolean).join(', ')}` : ''}`;
        })
        .join('\n')}\nFor per-Pokémon details (moves/items/abilities/sets) call lookupUsage.`
    : 'Live usage rankings are currently unavailable. Call lookupUsage per species; never assert usage percentages or "most common" claims from memory.';
  const teamSection = team?.length
    ? `Current team:\n${team
        .map((m) => {
          const forms = describeForms(m.species, m.item);
          return `  Slot ${m.slot}: ${m.species} @ ${m.item || '—'} | ${m.ability || '—'} | ${m.nature} | ${m.moves.filter(Boolean).join('/') || 'no moves'} | SP: ${fmtSp(m.sp)}${forms ? `\n    ${forms}` : ''}`;
        })
        .join('\n')}`
    : 'No team is currently loaded (all six slots are empty).';

  return `You are the assistant inside a Pokémon Champions (VGC doubles) team-building tool.
The active format is ${rules.label} (${rules.short}, ${rules.dates}): Level 50 doubles, bring 4 of 6.

═══ CHAMPIONS RULES — ABSOLUTE CONSTRAINTS ═══

STATS: Level 50, all IVs fixed at 31. Training uses Stat Points (SP): 0–32 per stat, 66 total.
1 SP ≈ 1 final stat point. Never mention EVs or IVs as inputs — use SP only.

NO TERASTALLIZATION: This format has no Tera mechanic. Never mention Tera, never suggest a Tera
type, refuse any Tera-based request.

MEGA EVOLUTION: Mega Evolution is a core mechanic. A Pokémon holding its Mega Stone Mega Evolves
on its first attack. Megas get new base stats, a new ability, and sometimes a new type. Always use
the EXACT hyphenated engine species name: "Dragonite-Mega", "Glimmora-Mega", "Aerodactyl-Mega", etc.
Every Mega-capable Pokémon in the team or on a screen is annotated MEGA-CAPABLE with BOTH formes'
typing, abilities, and base stats. Judge threats, speed, and damage by the Mega forme (it fights as
that from its first attack); mention the pre-Mega forme only for turn-one interactions (its ability
such as Intimidate/Multiscale triggers before the Mega ability takes over). Engine tools never Mega
Evolve on their own: pass the Mega species name to calc the Mega, the base name for pre-Mega.
ONE MEGA PER TEAM PER BATTLE — each team may Mega Evolve exactly one Pokémon per battle, regardless
of how many Mega-capable Pokémon are on that team. Never suggest strategies where two Pokémon from
the same team both Mega Evolve. Two opposing teams may each have one Mega active simultaneously.

LEGAL ITEMS: The format uses a whitelist. The COMPLETE legal item list for ${rules.short} is:
${legalItems.join(', ')}.
Any item not in this list is illegal — never suggest it, and correct the user if they assume an
absent item (e.g. Choice Band, Assault Vest, Rocky Helmet) is available. When choosing between
legal items, prefer what appears in usage data (call lookupUsage).

═══ METAGAME CONTEXT ═══

${championsMeta(ruleset)}

${rankingsSection}

Tempo & speed control:
• Fake Out is the dominant turn-1 tempo tool (Champions rule: selectable only on the user's first turn on
  the field). For who actually runs it in the current meta, check usage data — don't assert from memory.
  IMPORTANT: Fake Out is a Normal-type move — it has NO EFFECT on Ghost-type Pokémon.
• Tailwind doubles Speed for 4 turns. Trick Room reverses Speed order for 5 turns.
  Teams need redundant speed control (e.g. Tailwind + Icy Wind backup).
• Protect PP is capped at 8. Double-targeting to drain Protect PP is a win condition.
• Know base Speed tiers. Slower Megas need Trick Room or Tailwind; faster Megas contest the Speed tier.

SPEED CLAIMS: Never claim "X outspeeds Y" or state a Speed stat from memory — Champions stats and
formes differ from older formats and memory WILL be wrong. For ANY speed relationship, call
compareSpeed (it computes exact engine stats with nature, SP, stages, paralysis, Choice Scarf,
Tailwind, and Trick Room) and quote its numbers. Surface its speed-tie flags verbatim. Use
setupSpeedTier / updateSpeedTier afterwards when the user would benefit from seeing the comparison.

Team-building principles:
• Passive recovery is weak in doubles. Pressure and KO-focused play dominates stall.
• Always flag speed ties — they matter at the high end of the Speed bracket.
• Multiscale check: benchmark calcs against Dragonite-Mega must note whether Multiscale is active
  (full HP) or broken (chipped). Both scenarios are relevant in practice.
• "OHKOs" means the minimum roll exceeds max HP. "Rolls to OHKO" means at least one roll does so.
  Always report both via the engine.

═══ DAMAGE NUMBERS ═══

Never estimate damage. For any damage question call calcDamage and report the engine's exact output:
damage range, percent of max HP, KO chance, and caveat flags (speed ties, Multiscale, contact,
weather). Always surface these flags even if not asked.

When Multiscale is relevant, run two calcs: once at full HP (Multiscale active) and once with 1 HP
of chip removed (Multiscale broken).

═══ METAGAME COVERAGE ═══

Whether a set or a team covers the metagame is a question for threatMatrix, not for judgement. Call
it before saying what something beats, walls, checks, loses to, or is "covered" against — for a
team, call it for the members the claim rests on. It calcs the set both ways against the top of the
live rankings in one call. Cite what it found: name the opponents and quote its KO labels and
ranges. Never carry a coverage claim it did not support, and say plainly which holes it showed.

═══ CHANGING THE SCREEN (DIRECT ACTIONS) ═══

The user can ask you to change anything on any screen in plain language. When the request is
imperative — "set", "change", "put", "add", "remove", "swap", "turn on/off", "use", "make it",
"clear", "rename", "go to" — DO IT with the matching direct tool, without asking for confirmation:
• navigateTo        — switch tabs (team / calc / speed).
• updateCalc        — change the attacker, defender, or field on the Damage Calc screen. Only send
                      the fields that change. Use swap:true to flip attacker and defender. Use
                      run:true when the user wants numbers (the screen then calculates every move).
                      Any species is allowed on either side — the user's team members and any
                      opponent alike. Fill unspecified ability/item/moves from lookupUsage.
• updateSpeedTier   — toggle Tailwind (mine/opp), Trick Room, priority brackets; add team members
                      (addMine, slot numbers) or opponents (addOpponents); remove entries; patch an
                      entry's stage, paralysis, Choice Scarf, priority, nature, or Speed SP
                      (target = species name, or "slot N" for a team member). clear:true empties
                      the screen first.
• applyTeamEdit     — change item / ability / nature / moves / SP of a team slot right away.
• setTeamSlot       — put a Pokémon into a slot (empty or replacing) with a full set; fill any
                      unspecified parts from lookupUsage.
• removeTeamSlot    — empty a slot.
• reorderTeam       — move a Pokémon from one slot to another (the two slots swap).
• renameTeam        — rename the team.
Several changes in one request → several tool calls in one turn. After acting, reply with one or
two sentences saying what changed (no need to restate every field). If a direct tool returns a
legality error, fix the set and call it again — never leave the request half-done.

Use the propose* tools ONLY for suggestions the user did not explicitly ask you to apply
("what should I change?", "any ideas for slot 4?"). If the user says "do it" / "apply that" /
"go ahead" after a suggestion, apply it with the direct tool.

Every set that reaches the screen (direct or proposed) is validated server-side against the
Champions dex (species, moves, items, per-species abilities), species↔move learnsets (Gen 9
Showdown data grafted onto Champions — Champions-only moves pass through unchecked), and the
SP budget (0–32 per stat, ≤66 total).

SUBSTITUTIONS: When suggesting a new Pokémon for a slot, call lookupUsage first, then call
proposeSubstitution with the full set. Text reply = competitive reasoning (role, synergy, coverage,
Speed tier). Card = the set. Do not describe the set in text.

TEAM EDITS: Text = competitive insight (why this change helps). Card (proposeTeamEdit) = the actual
change. Never say "I suggest changing X to Y" in text — the card already shows that.

BENCHMARKS: Only propose via proposeBenchmark when the user asks. Include a natural-language
description ("OHKOs max HP Garchomp with Earthquake", "Outspeeds Adamant Arcanine-Hisui without
Tailwind").

Be concise and concrete. Every suggestion must have a specific competitive reason.

═══ CURRENT TEAM ═══

${teamSection}

═══ CURRENT SCREEN ═══

${describeScreen(context, team)}`;
}

// ─── UI tool declarations ──────────────────────────────────────────────────────

const setupDamageCalcDeclaration: FunctionDeclaration = {
  name: 'setupDamageCalc',
  description:
    'Populate the damage calc panel with a specific attacker vs defender matchup and switch the UI to the Damage Calc tab. Call lookupUsage first for any species where the user has not specified ability/item/moves, so you can fill in the most common set.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      attackerSpecies: { type: Type.STRING, description: 'Attacker species name.' },
      defenderSpecies: { type: Type.STRING, description: 'Defender species name.' },
      attackerAbility: { type: Type.STRING },
      attackerItem: { type: Type.STRING },
      attackerNature: { type: Type.STRING },
      attackerMoves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Up to 4 moves for the attacker.' },
      defenderAbility: { type: Type.STRING },
      defenderItem: { type: Type.STRING },
      defenderNature: { type: Type.STRING },
      defenderMoves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Up to 4 moves for the defender.' },
    },
    required: ['attackerSpecies', 'defenderSpecies'],
  },
};

const calcSidePatchSchema = {
  type: Type.OBJECT,
  description: 'Fields to change on this side. Omit anything that stays the same.',
  properties: {
    species: { type: Type.STRING, description: 'Exact engine species name.' },
    ability: { type: Type.STRING },
    item: { type: Type.STRING },
    nature: { type: Type.STRING },
    moves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Full new move list (up to 4).' },
    sp: spSchema,
  },
};

const updateCalcDeclaration: FunctionDeclaration = {
  name: 'updateCalc',
  description:
    'Directly change the Damage Calc screen: attacker and/or defender set (any species, partial fields), field conditions, swap the two sides, and optionally run every move. Applied immediately — use for imperative requests. Switches the UI to the Damage Calc tab.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      attacker: calcSidePatchSchema,
      defender: calcSidePatchSchema,
      field: {
        type: Type.OBJECT,
        properties: {
          gameType: { type: Type.STRING, description: '"Doubles" or "Singles".' },
          weather: { type: Type.STRING, description: 'Sun, Rain, Sand, Snow, or "" for none.' },
          terrain: { type: Type.STRING, description: 'Electric, Grassy, Psychic, Misty, or "" for none.' },
          isCrit: { type: Type.BOOLEAN },
        },
      },
      swap: { type: Type.BOOLEAN, description: 'Swap attacker and defender before applying the patches.' },
      run: { type: Type.BOOLEAN, description: 'Calculate every move after applying.' },
    },
  },
};

const speedOpponentSchema = {
  type: Type.OBJECT,
  properties: {
    species: { type: Type.STRING, description: 'Species name, e.g. "Incineroar".' },
    nature: { type: Type.STRING, description: 'Nature, if known.' },
    speSP: { type: Type.NUMBER, description: 'Speed SP (0–32), if known.' },
  },
  required: ['species'],
};

const setupSpeedTierDeclaration: FunctionDeclaration = {
  name: 'setupSpeedTier',
  description:
    'Replace the Speed Tier view contents with specific Pokémon and switch the UI to that tab. Use this whenever you discuss speed matchups, Tailwind turns, Trick Room, priority moves, or any relative Speed comparison. Pass team slot numbers for the user\'s Pokémon and species names for opponents. The view auto-fetches the top spread for each opponent.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mine: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: 'Team slot numbers (1–6) from the user\'s team to include.' },
      opponents: { type: Type.ARRAY, description: 'Opponent Pokémon to add.', items: speedOpponentSchema },
    },
  },
};

const updateSpeedTierDeclaration: FunctionDeclaration = {
  name: 'updateSpeedTier',
  description:
    'Directly edit the Speed Tiers screen without replacing it: toggles (Tailwind mine/opp, Trick Room, priority brackets), add team members or opponents, remove entries, or patch an entry\'s stage / paralysis / Choice Scarf / priority / nature / Speed SP. Applied immediately. Switches the UI to the Speed Tiers tab.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      toggles: {
        type: Type.OBJECT,
        properties: {
          tailwindMine: { type: Type.BOOLEAN },
          tailwindOpp: { type: Type.BOOLEAN },
          trickRoom: { type: Type.BOOLEAN },
          showPriority: { type: Type.BOOLEAN },
        },
      },
      clear: { type: Type.BOOLEAN, description: 'Remove every entry first.' },
      addMine: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: 'Team slot numbers (1–6) to add on the mine side.' },
      addOpponents: { type: Type.ARRAY, items: speedOpponentSchema },
      remove: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Entries to remove: species names, or "slot N" for team members.' },
      patch: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            target: { type: Type.STRING, description: 'Species name, or "slot N" for a team member.' },
            stage: { type: Type.NUMBER, description: 'Speed stat stage −6…+6.' },
            paralyzed: { type: Type.BOOLEAN },
            scarf: { type: Type.BOOLEAN, description: 'Holding Choice Scarf.' },
            priority: { type: Type.NUMBER, description: 'Move priority bracket, e.g. 3 for Fake Out, -7 for Trick Room.' },
            nature: { type: Type.STRING, description: 'Opponents only.' },
            speSP: { type: Type.NUMBER, description: 'Opponents only. Speed SP 0–32.' },
          },
          required: ['target'],
        },
      },
    },
  },
};

const teamChangesSchema = {
  type: Type.OBJECT,
  description: 'Fields to change. Only include fields that are actually changing.',
  properties: {
    item: { type: Type.STRING },
    ability: { type: Type.STRING },
    nature: { type: Type.STRING },
    moves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Full new moveset (all 4 slots).' },
    sp: { ...spSchema, description: 'New SP values (only include stats that are changing).' },
  },
};

const proposeTeamEditDeclaration: FunctionDeclaration = {
  name: 'proposeTeamEdit',
  description:
    'Suggest a change to a team slot. A diff card appears for the user to accept or reject. Use only for suggestions the user did not ask you to apply. Always include a reason explaining the competitive benefit.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slot: { type: Type.NUMBER, description: 'Team slot number (1–6).' },
      changes: teamChangesSchema,
      reason: { type: Type.STRING, description: 'Why this change improves the team.' },
    },
    required: ['slot', 'changes', 'reason'],
  },
};

const applyTeamEditDeclaration: FunctionDeclaration = {
  name: 'applyTeamEdit',
  description:
    'Directly change a team slot\'s item / ability / nature / moves / SP. Applied immediately — use when the user asked for the change. Only slots that currently hold a Pokémon.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slot: { type: Type.NUMBER, description: 'Team slot number (1–6).' },
      changes: teamChangesSchema,
    },
    required: ['slot', 'changes'],
  },
};

const proposeBenchmarkDeclaration: FunctionDeclaration = {
  name: 'proposeBenchmark',
  description:
    'Propose a benchmark check for a team Pokémon. The user sees an accept/reject card. Only call this when the user asks you to suggest benchmarks — never call it unprompted. Include a natural-language description like "OHKOs max HP Garchomp with Earthquake" or "Outspeeds Adamant Arcanine-Hisui without Tailwind."',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slot: { type: Type.NUMBER, description: 'Team slot number (1–6).' },
      description: { type: Type.STRING, description: 'Natural-language description of the benchmark, e.g. "OHKOs max HP Garchomp with Earthquake".' },
      reason: { type: Type.STRING, description: 'Why this benchmark matters for the team.' },
    },
    required: ['slot', 'description', 'reason'],
  },
};

const fullSetProperties = {
  slot: { type: Type.NUMBER, description: 'Team slot number (1–6) to fill or replace.' },
  species: { type: Type.STRING, description: 'Exact engine species name, e.g. "Landorus-Therian".' },
  ability: { type: Type.STRING },
  item: { type: Type.STRING },
  nature: { type: Type.STRING },
  moves: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Up to 4 moves.' },
  sp: spSchema,
};

const proposeSubstitutionDeclaration: FunctionDeclaration = {
  name: 'proposeSubstitution',
  description:
    'Suggest replacing a team slot with a different Pokémon, or adding a Pokémon to an empty slot. Always call lookupUsage first to fill in the best ability/item/moves for the suggested species. The user sees an accept/reject card showing the full suggested set. Use only for suggestions the user did not ask you to apply.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      ...fullSetProperties,
      reason: { type: Type.STRING, description: 'One sentence: why this Pokémon improves the team.' },
    },
    required: ['slot', 'species', 'reason'],
  },
};

const setTeamSlotDeclaration: FunctionDeclaration = {
  name: 'setTeamSlot',
  description:
    'Directly put a Pokémon into a team slot (empty or replacing what is there) with a full set. Applied immediately — use when the user asked for it ("add Incineroar in slot 3", "replace Weavile with Rillaboom"). Unspecified ability/item/nature/moves/SP are filled from usage data.',
  parameters: {
    type: Type.OBJECT,
    properties: fullSetProperties,
    required: ['slot', 'species'],
  },
};

const removeTeamSlotDeclaration: FunctionDeclaration = {
  name: 'removeTeamSlot',
  description: 'Directly empty a team slot. Applied immediately.',
  parameters: {
    type: Type.OBJECT,
    properties: { slot: { type: Type.NUMBER, description: 'Team slot number (1–6).' } },
    required: ['slot'],
  },
};

const reorderTeamDeclaration: FunctionDeclaration = {
  name: 'reorderTeam',
  description: 'Directly move a Pokémon from one slot to another; the two slots swap. Applied immediately.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      from: { type: Type.NUMBER, description: 'Slot number (1–6) to move.' },
      to: { type: Type.NUMBER, description: 'Destination slot number (1–6).' },
    },
    required: ['from', 'to'],
  },
};

const renameTeamDeclaration: FunctionDeclaration = {
  name: 'renameTeam',
  description: 'Directly rename the current team. Applied immediately.',
  parameters: {
    type: Type.OBJECT,
    properties: { name: { type: Type.STRING } },
    required: ['name'],
  },
};

const navigateToDeclaration: FunctionDeclaration = {
  name: 'navigateTo',
  description: 'Switch the UI to a tab: "team", "calc" (Damage Calc), or "speed" (Speed Tiers).',
  parameters: {
    type: Type.OBJECT,
    properties: { tab: { type: Type.STRING, description: '"team", "calc", or "speed".' } },
    required: ['tab'],
  },
};

// ─── Tool input types ──────────────────────────────────────────────────────────

interface SetupDamageCalcArgs {
  attackerSpecies: string;
  defenderSpecies: string;
  attackerAbility?: string;
  attackerItem?: string;
  attackerNature?: string;
  attackerMoves?: string[];
  defenderAbility?: string;
  defenderItem?: string;
  defenderNature?: string;
  defenderMoves?: string[];
}
interface CalcSidePatch {
  species?: string;
  ability?: string;
  item?: string;
  nature?: string;
  moves?: string[];
  sp?: Record<string, number>;
}
interface UpdateCalcArgs {
  attacker?: CalcSidePatch;
  defender?: CalcSidePatch;
  field?: { gameType?: string; weather?: string; terrain?: string; isCrit?: boolean };
  swap?: boolean;
  run?: boolean;
}
interface TeamChanges {
  item?: string;
  ability?: string;
  nature?: string;
  moves?: string[];
  sp?: Record<string, number>;
}
interface ProposeTeamEditArgs { slot: number; changes: TeamChanges; reason: string }
interface ApplyTeamEditArgs { slot: number; changes: TeamChanges }
interface ProposeBenchmarkArgs { slot: number; description: string; reason: string }
interface FullSetArgs {
  slot: number;
  species: string;
  ability?: string;
  item?: string;
  nature?: string;
  moves?: string[];
  sp?: Record<string, number>;
}
interface ProposeSubstitutionArgs extends FullSetArgs { reason: string }
interface SetupSpeedTierArgs { mine?: number[]; opponents?: SpeedOpponent[] }
interface UpdateSpeedTierArgs {
  toggles?: UpdateSpeedTierAction['toggles'];
  clear?: boolean;
  addMine?: number[];
  addOpponents?: SpeedOpponent[];
  remove?: string[];
  patch?: SpeedEntryPatch[];
}

// ─── Executors ─────────────────────────────────────────────────────────────────

async function executeSetupDamageCalc(args: SetupDamageCalcArgs, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  try {
    const [attacker, defender] = await Promise.all([
      buildSetFromUsage(args.attackerSpecies, {
        ability: args.attackerAbility,
        item: args.attackerItem,
        nature: args.attackerNature,
        moves: args.attackerMoves,
      }, ruleset),
      buildSetFromUsage(args.defenderSpecies, {
        ability: args.defenderAbility,
        item: args.defenderItem,
        nature: args.defenderNature,
        moves: args.defenderMoves,
      }, ruleset),
    ]);

    const [attackerErrors, defenderErrors] = await Promise.all([
      validateProposal(attacker.species, { ability: attacker.ability, item: attacker.item, moves: attacker.moves, sp: attacker.sp }, ruleset),
      validateProposal(defender.species, { ability: defender.ability, item: defender.item, moves: defender.moves, sp: defender.sp }, ruleset),
    ]);
    const problems = [
      ...attackerErrors.map((e) => `attacker: ${e}`),
      ...defenderErrors.map((e) => `defender: ${e}`),
    ];
    if (problems.length) {
      return { error: `Illegal calc setup rejected:\n- ${problems.join('\n- ')}` };
    }

    pendingActions.push({ type: 'setupDamageCalc', attacker, defender });
    return { status: 'ok', attacker: fmtSet(attacker), defender: fmtSet(defender) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Resolve a partial side patch against what is on screen, filling gaps from usage data when the
 * species changes, then validate the resulting full set.
 */
async function resolveCalcSide(
  current: CalcMonSet | undefined,
  patch: CalcSidePatch | undefined,
  label: string,
  ruleset: RulesetId,
): Promise<{ patch?: Partial<CalcMonSet>; errors: string[] }> {
  if (!patch) return { errors: [] };
  const speciesChanged = !!patch.species && patch.species !== current?.species;
  if (patch.species && !isLegalSpecies(patch.species, ruleset)) {
    return { errors: [`${label}: ${patch.species} is not usable in ${getRuleset(ruleset).short}.`] };
  }
  let resolved: Partial<CalcMonSet>;
  if (speciesChanged) {
    // New species: anything not given comes from usage, so the side is never left half-filled.
    resolved = await buildSetFromUsage(patch.species!, {
      ability: patch.ability,
      item: patch.item,
      nature: patch.nature,
      moves: patch.moves,
      sp: patch.sp as SpSpread | undefined,
    }, ruleset);
  } else {
    resolved = {
      ...(patch.ability !== undefined ? { ability: patch.ability } : {}),
      ...(patch.item !== undefined ? { item: patch.item } : {}),
      ...(patch.nature !== undefined ? { nature: patch.nature } : {}),
      ...(patch.moves !== undefined ? { moves: patch.moves.filter(Boolean).slice(0, 4) } : {}),
      ...(patch.sp !== undefined ? { sp: patch.sp as SpSpread } : {}),
    };
  }
  const merged: CalcMonSet = {
    species: resolved.species ?? current?.species ?? patch.species ?? '',
    ability: resolved.ability ?? current?.ability ?? '',
    item: resolved.item ?? current?.item ?? '',
    nature: resolved.nature ?? current?.nature ?? 'Hardy',
    sp: { ...(current?.sp ?? {}), ...(resolved.sp ?? {}) },
    moves: resolved.moves ?? current?.moves ?? [],
  };
  const errors = (await validateProposal(merged.species, { ability: merged.ability, item: merged.item, moves: merged.moves, sp: merged.sp }, ruleset))
    .map((e) => `${label}: ${e}`);
  return { patch: resolved, errors };
}

async function executeUpdateCalc(args: UpdateCalcArgs, context: ScreenContext | undefined, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  const calc = context?.calc;
  // After a swap the "attacker" patch lands on what is currently the defender, and vice versa.
  const currentAtk = args.swap ? calc?.defender : calc?.attacker;
  const currentDef = args.swap ? calc?.attacker : calc?.defender;
  const [atk, def] = await Promise.all([
    resolveCalcSide(currentAtk, args.attacker, 'attacker', ruleset),
    resolveCalcSide(currentDef, args.defender, 'defender', ruleset),
  ]);
  const errors = [...atk.errors, ...def.errors];
  if (errors.length) return { error: `Illegal calc change rejected:\n- ${errors.join('\n- ')}` };

  const field: UpdateCalcAction['field'] = {};
  if (args.field?.gameType) field.gameType = args.field.gameType === 'Singles' ? 'Singles' : 'Doubles';
  if (args.field?.weather !== undefined) field.weather = args.field.weather;
  if (args.field?.terrain !== undefined) field.terrain = args.field.terrain;
  if (args.field?.isCrit !== undefined) field.isCrit = !!args.field.isCrit;

  const action: UpdateCalcAction = {
    type: 'updateCalc',
    ...(atk.patch ? { attacker: atk.patch } : {}),
    ...(def.patch ? { defender: def.patch } : {}),
    ...(Object.keys(field).length ? { field } : {}),
    ...(args.swap ? { swap: true } : {}),
    ...(args.run ? { run: true } : {}),
  };
  if (!action.attacker && !action.defender && !action.field && !action.swap && !action.run) {
    return { error: 'Nothing to change — provide attacker, defender, field, swap, or run.' };
  }
  pendingActions.push(action);
  return {
    status: 'ok',
    applied: {
      ...(action.swap ? { swapped: true } : {}),
      ...(action.attacker ? { attacker: action.attacker } : {}),
      ...(action.defender ? { defender: action.defender } : {}),
      ...(action.field ? { field: action.field } : {}),
      ...(action.run ? { ran: 'all moves' } : {}),
    },
  };
}

async function executeProposeTeamEdit(args: ProposeTeamEditArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  const mon = team?.find((m) => m.slot === args.slot);
  if (!mon) return { error: `No Pokémon in slot ${args.slot}. Check the team in the system prompt.` };
  const mergedSp = args.changes.sp ? ({ ...mon.sp, ...args.changes.sp } as SpSpread) : undefined;
  const errors = await validateProposal(mon.species, {
    ability: args.changes.ability,
    item: args.changes.item,
    moves: args.changes.moves,
    sp: mergedSp,
  }, ruleset);
  if (errors.length) return { error: `Illegal proposal rejected:\n- ${errors.join('\n- ')}` };
  const action: ProposeTeamEditAction = {
    type: 'proposeTeamEdit',
    slot: args.slot,
    label: mon.species,
    changes: args.changes as ProposeTeamEditAction['changes'],
    reason: args.reason,
  };
  pendingActions.push(action);
  return { status: 'ok', message: `Proposed edit to Slot ${args.slot} (${mon.species}). The user will see a diff card to accept or reject.` };
}

async function executeApplyTeamEdit(args: ApplyTeamEditArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  const mon = team?.find((m) => m.slot === args.slot);
  if (!mon) return { error: `No Pokémon in slot ${args.slot}. Use setTeamSlot to fill an empty slot.` };
  const mergedSp = args.changes.sp ? ({ ...mon.sp, ...args.changes.sp } as SpSpread) : undefined;
  const errors = await validateProposal(mon.species, {
    ability: args.changes.ability,
    item: args.changes.item,
    moves: args.changes.moves,
    sp: mergedSp,
  }, ruleset);
  if (errors.length) return { error: `Illegal change rejected:\n- ${errors.join('\n- ')}` };
  pendingActions.push({ type: 'applyTeamEdit', slot: args.slot, changes: args.changes as ProposeTeamEditAction['changes'] });
  return { status: 'ok', message: `Applied to Slot ${args.slot} (${mon.species}).`, changes: args.changes };
}

function executeProposeBenchmark(args: ProposeBenchmarkArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[]): unknown {
  const mon = team?.find((m) => m.slot === args.slot);
  if (!mon) return { error: `No Pokémon in slot ${args.slot}.` };
  const action: ProposeBenchmarkAction = { type: 'proposeBenchmark', slot: args.slot, description: args.description, reason: args.reason };
  pendingActions.push(action);
  return { status: 'ok', message: `Proposed benchmark for Slot ${args.slot} (${mon.species}). The user will see a card to accept or reject.` };
}

async function buildFullSet(args: FullSetArgs, ruleset: RulesetId): Promise<{ set: CalcMonSet; errors: string[] }> {
  const set = await buildSetFromUsage(args.species, {
    ability: args.ability,
    item: args.item,
    nature: args.nature,
    moves: args.moves,
    sp: args.sp as SpSpread | undefined,
  }, ruleset);
  const errors = await validateProposal(set.species, { ability: set.ability, item: set.item, moves: set.moves, sp: set.sp }, ruleset);
  return { set, errors };
}

async function executeProposeSubstitution(args: ProposeSubstitutionArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  if (args.slot < 1 || args.slot > 6) return { error: 'Slot must be between 1 and 6.' };
  const { set, errors } = await buildFullSet(args, ruleset);
  if (errors.length) return { error: `Illegal proposal rejected:\n- ${errors.join('\n- ')}` };
  const currentMon = team?.find((m) => m.slot === args.slot);
  const action: ProposeSubstitutionAction = { type: 'proposeSubstitution', slot: args.slot, ...set, reason: args.reason };
  pendingActions.push(action);
  return {
    status: 'ok',
    message: `Proposed ${args.species} for slot ${args.slot}${currentMon ? ` (replacing ${currentMon.species})` : ' (empty slot)'}. The user will see a proposal card to accept or reject.`,
  };
}

async function executeSetTeamSlot(args: FullSetArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[], ruleset: RulesetId): Promise<unknown> {
  if (args.slot < 1 || args.slot > 6) return { error: 'Slot must be between 1 and 6.' };
  const { set, errors } = await buildFullSet(args, ruleset);
  if (errors.length) return { error: `Illegal set rejected:\n- ${errors.join('\n- ')}` };
  const duplicate = team?.find((m) => m.slot !== args.slot && m.species === set.species);
  if (duplicate) return { error: `${set.species} is already in slot ${duplicate.slot} — Species Clause allows one of each.` };
  const currentMon = team?.find((m) => m.slot === args.slot);
  pendingActions.push({ type: 'setTeamSlot', slot: args.slot, ...set });
  return {
    status: 'ok',
    message: `Placed ${set.species} in slot ${args.slot}${currentMon ? ` (replacing ${currentMon.species})` : ''}.`,
    set: fmtSet(set),
  };
}

function executeRemoveTeamSlot(args: { slot: number }, team: TeamMon[] | undefined, pendingActions: ChatAction[]): unknown {
  const mon = team?.find((m) => m.slot === args.slot);
  if (!mon) return { error: `Slot ${args.slot} is already empty.` };
  pendingActions.push({ type: 'removeTeamSlot', slot: args.slot });
  return { status: 'ok', message: `Removed ${mon.species} from slot ${args.slot}.` };
}

function executeReorderTeam(args: { from: number; to: number }, team: TeamMon[] | undefined, pendingActions: ChatAction[]): unknown {
  const bad = [args.from, args.to].find((n) => !(n >= 1 && n <= 6));
  if (bad !== undefined) return { error: `Slot ${bad} is out of range (1–6).` };
  if (args.from === args.to) return { error: 'from and to are the same slot.' };
  const mon = team?.find((m) => m.slot === args.from);
  if (!mon) return { error: `Slot ${args.from} is empty.` };
  pendingActions.push({ type: 'reorderTeam', from: args.from, to: args.to });
  return { status: 'ok', message: `Moved ${mon.species} from slot ${args.from} to slot ${args.to} (slots swapped).` };
}

function executeRenameTeam(args: { name: string }, pendingActions: ChatAction[]): unknown {
  const name = (args.name ?? '').trim();
  if (!name) return { error: 'Name is empty.' };
  pendingActions.push({ type: 'renameTeam', name });
  return { status: 'ok', message: `Team renamed to "${name}".` };
}

function executeNavigateTo(args: { tab: string }, pendingActions: ChatAction[]): unknown {
  const tab = (args.tab ?? '').toLowerCase();
  const view: WorkspaceView | null = tab.startsWith('team') ? 'team' : tab.startsWith('calc') || tab.includes('damage') ? 'calc' : tab.startsWith('speed') ? 'speed' : null;
  if (!view) return { error: 'tab must be "team", "calc", or "speed".' };
  pendingActions.push({ type: 'navigateTo', tab: view });
  return { status: 'ok', message: `Switched to the ${VIEW_LABEL[view]} tab.` };
}

function executeSetupSpeedTier(args: SetupSpeedTierArgs, team: TeamMon[] | undefined, pendingActions: ChatAction[], ruleset: RulesetId): unknown {
  const mine = (args.mine ?? []).filter((s) => s >= 1 && s <= 6);
  const opponents = (args.opponents ?? []).filter((o) => o.species);
  if (!mine.length && !opponents.length) return { error: 'Provide at least one team slot or opponent species.' };
  const illegal = opponents.filter((o) => !isLegalSpecies(o.species, ruleset)).map((o) => o.species);
  if (illegal.length) return { error: `Not usable in ${getRuleset(ruleset).short}: ${illegal.join(', ')}.` };
  const included = mine.map((s) => team?.find((m) => m.slot === s)?.species ?? `Slot ${s}`);
  pendingActions.push({ type: 'setupSpeedTier', mine, opponents });
  return {
    status: 'ok',
    message: `Speed Tier view populated with ${included.length ? included.join(', ') : 'no team members'} and ${opponents.length} opponent(s). Switched to Speed Tier tab.`,
  };
}

function executeUpdateSpeedTier(args: UpdateSpeedTierArgs, pendingActions: ChatAction[], ruleset: RulesetId): unknown {
  const addOpponents = (args.addOpponents ?? []).filter((o) => o.species);
  const illegal = addOpponents.filter((o) => !isLegalSpecies(o.species, ruleset)).map((o) => o.species);
  if (illegal.length) return { error: `Not usable in ${getRuleset(ruleset).short}: ${illegal.join(', ')}.` };
  const action: UpdateSpeedTierAction = {
    type: 'updateSpeedTier',
    ...(args.toggles ? { toggles: args.toggles } : {}),
    ...(args.clear ? { clear: true } : {}),
    ...(args.addMine?.length ? { addMine: args.addMine.filter((s) => s >= 1 && s <= 6) } : {}),
    ...(addOpponents.length ? { addOpponents } : {}),
    ...(args.remove?.length ? { remove: args.remove } : {}),
    ...(args.patch?.length ? { patch: args.patch } : {}),
  };
  const { type: _t, ...rest } = action;
  void _t;
  if (!Object.keys(rest).length) return { error: 'Nothing to change.' };
  pendingActions.push(action);
  return { status: 'ok', applied: rest };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}
export interface ChatReply {
  text: string;
  toolCalls: ToolInvocation[];
  actions: ChatAction[];
}

export async function runChampionsChat(
  client: LlmClient,
  history: ChatMessage[],
  team?: TeamMon[],
  context?: ScreenContext,
  ruleset: RulesetId = DEFAULT_RULESET,
): Promise<ChatReply> {
  const messages: LlmMessage[] = history.map((m) => m.role === 'user' ? { role: 'user', text: m.text } : { role: 'assistant', text: m.text, toolCalls: [] });
  const pendingActions: ChatAction[] = [];
  const system = await buildSystemInstruction(team, context, ruleset);

  const { text, toolCalls, exhausted } = await runToolLoop({
    client,
    system,
    messages,
    ruleset,
    maxRounds: MAX_TOOL_ROUNDS,
    declarations: [
      calcDamageDeclaration,
      lookupUsageDeclaration,
      compareSpeedDeclaration,
      threatMatrixDeclaration,
      navigateToDeclaration,
      setupDamageCalcDeclaration,
      updateCalcDeclaration,
      setupSpeedTierDeclaration,
      updateSpeedTierDeclaration,
      applyTeamEditDeclaration,
      setTeamSlotDeclaration,
      removeTeamSlotDeclaration,
      reorderTeamDeclaration,
      renameTeamDeclaration,
      proposeTeamEditDeclaration,
      proposeBenchmarkDeclaration,
      proposeSubstitutionDeclaration,
    ],
    dispatch: async (name, args) => {
      switch (name) {
        case 'navigateTo': return executeNavigateTo(args as { tab: string }, pendingActions);
        case 'setupDamageCalc': return executeSetupDamageCalc(args as SetupDamageCalcArgs, pendingActions, ruleset);
        case 'updateCalc': return executeUpdateCalc(args as UpdateCalcArgs, context, pendingActions, ruleset);
        case 'setupSpeedTier': return executeSetupSpeedTier(args as SetupSpeedTierArgs, team, pendingActions, ruleset);
        case 'updateSpeedTier': return executeUpdateSpeedTier(args as UpdateSpeedTierArgs, pendingActions, ruleset);
        case 'applyTeamEdit': return executeApplyTeamEdit(args as ApplyTeamEditArgs, team, pendingActions, ruleset);
        case 'setTeamSlot': return executeSetTeamSlot(args as FullSetArgs, team, pendingActions, ruleset);
        case 'removeTeamSlot': return executeRemoveTeamSlot(args as { slot: number }, team, pendingActions);
        case 'reorderTeam': return executeReorderTeam(args as { from: number; to: number }, team, pendingActions);
        case 'renameTeam': return executeRenameTeam(args as { name: string }, pendingActions);
        case 'proposeTeamEdit': return executeProposeTeamEdit(args as ProposeTeamEditArgs, team, pendingActions, ruleset);
        case 'proposeBenchmark': return executeProposeBenchmark(args as ProposeBenchmarkArgs, team, pendingActions);
        case 'proposeSubstitution': return executeProposeSubstitution(args as ProposeSubstitutionArgs, team, pendingActions, ruleset);
        default: return { error: `Unknown tool: ${name}` };
      }
    },
  });

  if (exhausted) {
    return { text: 'Stopped after too many tool calls — please refine the question.', toolCalls, actions: pendingActions };
  }
  return { text, toolCalls, actions: pendingActions };
}
