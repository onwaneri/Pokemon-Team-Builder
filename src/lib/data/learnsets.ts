/**
 * Species↔move legality: Showdown/@pkmn/dex Gen 9 learnsets, corrected by what Champions players
 * actually run.
 *
 * Champions ships no learnset table (neither the vendored @smogon/calc gen-0 data nor Pikalytics
 * exposes one), so mainline Showdown learnsets are the base approximation. Champions also teaches
 * moves Gen 9 never did (Swampert's Wave Crash is its most-used move there and absent from every
 * Scarlet/Violet learnset), so Pikalytics usage is treated as positive evidence: a move with
 * ranked usage on a species in the current format is learnable by definition. Verdicts are
 * three-state and rejection requires positive evidence:
 *   - 'yes'     → the move appears in the forme → base-species → prevo learnset chain, OR it has
 *                 usage on this species in the ruleset's Pikalytics format.
 *   - 'no'      → the dex teaches this move to at least one species (so it has coverage for it),
 *                 this species' chain provably lacks it, and usage shows nobody running it.
 *   - 'unknown' → the species or move is unknown to the dex, or the move exists but is taught
 *                 nowhere (e.g. Champions-only signatures like Nihil Light) — never rejected.
 * Usage evidence is best-effort: if Pikalytics is unreachable the Gen 9 verdict stands alone.
 *
 * Server-only (walks the full @pkmn/dex learnset dataset; coverage set built once and cached).
 */
import { Dex } from '@pkmn/dex';
import { listMoves } from './champions';
import { fetchUsage } from './usage';
import { DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';

export type LearnVerdict = 'yes' | 'no' | 'unknown';

// Moves the dex teaches to at least one species. A move outside this set has no learnset coverage,
// so its absence from a species' learnset proves nothing.
let coveredMoves: Promise<Set<string>> | null = null;
function movesWithLearnsetCoverage(): Promise<Set<string>> {
  return (coveredMoves ??= (async () => {
    const covered = new Set<string>();
    for (const sp of Dex.species.all()) {
      const l = await Dex.learnsets.get(sp.id);
      for (const id of Object.keys(l?.learnset ?? {})) covered.add(id);
    }
    return covered;
  })());
}

/**
 * Every move id in the learnsets along the forme → base species → prevo chain (Megas carry no
 * learnset of their own; egg moves may only be recorded on earlier evolution stages). Null when
 * the dex does not know the species at all.
 */
const chainCache = new Map<string, Promise<Set<string> | null>>();
function chainMoveIds(speciesName: string): Promise<Set<string> | null> {
  let p = chainCache.get(speciesName);
  if (!p) {
    p = (async () => {
      if (!Dex.species.get(speciesName)?.exists) return null;
      const ids = new Set<string>();
      let current: string | undefined = speciesName;
      const seen = new Set<string>();
      while (current) {
        const sp = Dex.species.get(current);
        if (!sp?.exists || seen.has(sp.id)) break;
        seen.add(sp.id);
        const l = await Dex.learnsets.get(sp.id);
        for (const id of Object.keys(l?.learnset ?? {})) ids.add(id);
        current = sp.baseSpecies !== sp.name ? sp.baseSpecies : sp.prevo || undefined;
      }
      return ids;
    })();
    chainCache.set(speciesName, p);
  }
  return p;
}

/**
 * Move ids Pikalytics reports with usage on this species in the ruleset's format (empty when the
 * species has no page or the fetch fails). `fetchUsage` carries its own persistent cache, so this
 * is cheap after the first lookup.
 */
async function observedMoveIds(speciesName: string, reg: RulesetId): Promise<Set<string>> {
  const ids = new Set<string>();
  const usage = await fetchUsage(speciesName, reg);
  for (const entry of usage?.moves ?? []) {
    if (!(entry.pct > 0)) continue;
    const move = Dex.moves.get(entry.name);
    if (move?.exists) ids.add(move.id);
  }
  return ids;
}

export async function canLearn(speciesName: string, moveName: string, reg: RulesetId = DEFAULT_RULESET): Promise<LearnVerdict> {
  const move = Dex.moves.get(moveName);
  if (!move?.exists) return 'unknown';
  if (!(await movesWithLearnsetCoverage()).has(move.id)) return 'unknown';
  const chain = await chainMoveIds(speciesName);
  if (!chain) return 'unknown';
  if (chain.has(move.id)) return 'yes';
  return (await observedMoveIds(speciesName, reg)).has(move.id) ? 'yes' : 'no';
}

/** A species' legal move pool split by learnset verdict, for the move pickers. */
export interface SpeciesLearnset {
  species: string;
  /** False when the dex does not know the species: every legal move is offered, none is verified. */
  verified: boolean;
  /** Legal moves found in the forme → base → prevo learnset chain or seen in usage, alphabetical. */
  learnable: string[];
  /** Legal moves the dex has no evidence about (Champions-only, or taught to nobody in Gen 9). */
  unverified: string[];
}

const LEARNSET_MEMO_MS = 10 * 60_000;
const learnsetCache = new Map<string, { p: Promise<SpeciesLearnset>; at: number }>();
/**
 * Memoized per ruleset+species for ten minutes (the dex half is static; the usage half follows
 * Pikalytics). The whole pool is classified in one pass (~1 ms after warmup).
 */
export function learnsetFor(speciesName: string, reg: RulesetId): Promise<SpeciesLearnset> {
  const key = `${reg}:${speciesName}`;
  const hit = learnsetCache.get(key);
  if (hit && Date.now() - hit.at < LEARNSET_MEMO_MS) return hit.p;
  const p = (async () => {
    const pool = listMoves(reg);
    const chain = await chainMoveIds(speciesName);
    if (!chain) return { species: speciesName, verified: false, learnable: pool, unverified: [] };
    const [covered, observed] = await Promise.all([movesWithLearnsetCoverage(), observedMoveIds(speciesName, reg)]);
    const learnable: string[] = [];
    const unverified: string[] = [];
    for (const name of pool) {
      const move = Dex.moves.get(name);
      if (move?.exists && (chain.has(move.id) || observed.has(move.id))) learnable.push(name);
      else if (!move?.exists || !covered.has(move.id)) unverified.push(name);
    }
    return { species: speciesName, verified: true, learnable, unverified };
  })();
  learnsetCache.set(key, { p, at: Date.now() });
  p.catch(() => learnsetCache.delete(key));
  return p;
}

/** Human-readable learnset violations for a moveset, with the graft's provenance stated. */
export async function learnsetIssues(speciesName: string, moves: string[], reg: RulesetId = DEFAULT_RULESET): Promise<string[]> {
  const issues: string[] = [];
  for (const m of moves) {
    if (!m) continue;
    if ((await canLearn(speciesName, m, reg)) === 'no') {
      issues.push(
        `${speciesName} cannot learn ${m} (per Gen 9 Showdown learnset data, and no Champions usage shows it).`,
      );
    }
  }
  return issues;
}
