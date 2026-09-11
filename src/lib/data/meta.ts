/**
 * Strategic Champions metagame context for the model (Layer 3). Every claim here is traceable to
 * `context/ground-truth-reg-mb.md` / `context/ground-truth-vgc-mechanics.md` — do not add usage
 * claims ("top users of X are …") to this string: usage is live data and must come from the
 * lookupUsage / fetchFormatRankings tools, never from static text. Numbers are still always
 * computed by the engine — this is qualitative context only.
 *
 * The baseline below is the Reg M-B substrate; `championsMeta(ruleset)` appends the active
 * ruleset's own notes (src/lib/rulesets) so the model knows what changed without the baseline
 * being rewritten per regulation.
 */
import { getRuleset, DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';

const BASELINE = `Pokémon Champions metagame context (VGC doubles, bring 4 of 6; baseline from the Reg M-B ground truth):

Dominant Mega threats to benchmark against:
- Dragonite-Mega: Multiscale (halves damage at full HP — chip first), premier Tailwind setter, special attacker, base 100 Spe.
- Glimmora-Mega: Adaptability (2x STAB) Sludge Bomb threatens Fairies; Toxic Debris punishes physical contact; hazard pivot.
- Aerodactyl-Mega: Unnerve fast Tailwind lead (blocks berries; known bug: entry-activation abilities still allow berry consumption).
- Archaludon (non-Mega staple): Stamina bulk, Electro Shot fires instantly in Rain.

Tempo & speed control:
- Fake Out is the key turn-1 tempo tool (Champions rule: it can only be selected on the user's first turn on the field). For current top Fake Out users, check live usage data — never assert usage from memory.
- Carry redundant speed control (e.g. Tailwind + Icy Wind). Tailwind doubles Speed 4 turns; Trick Room reverses order 5 turns. Dynamic Speed: turn order recalculates immediately mid-turn after any speed change.
- Protect variants are capped at 8 PP — double-targeting to drain Protect PP is a win condition.

Principles: pressure over stall (the draw rule removed the HP tiebreaker — secure KOs before time); always know base speed tiers for when Tailwind/Trick Room expires; flag speed ties.`;

/** Baseline context plus the active ruleset's delta notes. */
export function championsMeta(ruleset: RulesetId = DEFAULT_RULESET): string {
  const r = getRuleset(ruleset);
  const header = `Active regulation: ${r.label} (${r.dates}).`;
  return r.notes ? `${header}\n\n${BASELINE}\n\n${r.label} specifics:\n${r.notes}` : `${header}\n\n${BASELINE}`;
}
