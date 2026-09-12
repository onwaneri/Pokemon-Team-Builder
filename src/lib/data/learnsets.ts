/**
 * Species↔move legality via Showdown/@pkmn/dex learnset data — a Gen 9 GRAFT, not Champions truth.
 *
 * Champions ships no learnset table (neither the vendored @smogon/calc gen-0 data nor Pikalytics
 * exposes one), so mainline Showdown learnsets are the best available approximation. To avoid the
 * graft rejecting things Champions legitimately added, verdicts are three-state and rejection
 * requires positive evidence:
 *   - 'no'      → the dex teaches this move to at least one species (so it has coverage for it),
 *                 and this species' forme/prevo chain provably lacks it.
 *   - 'yes'     → the move appears somewhere in the forme → base-species → prevo chain.
 *   - 'unknown' → the species or move is unknown to the dex, or the move exists but is taught
 *                 nowhere (e.g. Champions-only signatures like Nihil Light) — never rejected.
 *
 * Server-only (walks the full @pkmn/dex learnset dataset; coverage set built once and cached).
 */
import { Dex } from '@pkmn/dex';
import { listMoves } from './champions';
import type { RulesetId } from '@/lib/rulesets';

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

export async function canLearn(speciesName: string, moveName: string): Promise<LearnVerdict> {
  const move = Dex.moves.get(moveName);
  if (!move?.exists) return 'unknown';
  if (!(await movesWithLearnsetCoverage()).has(move.id)) return 'unknown';
  const chain = await chainMoveIds(speciesName);
  if (!chain) return 'unknown';
  return chain.has(move.id) ? 'yes' : 'no';
}

/** A species' legal move pool split by learnset verdict, for the move pickers. */
export interface SpeciesLearnset {
  species: string;
  /** False when the dex does not know the species: every legal move is offered, none is verified. */
  verified: boolean;
  /** Legal moves found in the forme → base → prevo learnset chain, alphabetical. */
  learnable: string[];
  /** Legal moves the dex has no evidence about (Champions-only, or taught to nobody in Gen 9). */
  unverified: string[];
}

const learnsetCache = new Map<string, Promise<SpeciesLearnset>>();
/** Memoized per ruleset+species; the whole pool is classified in one pass (~1 ms after warmup). */
export function learnsetFor(speciesName: string, reg: RulesetId): Promise<SpeciesLearnset> {
  const key = `${reg}:${speciesName}`;
  let p = learnsetCache.get(key);
  if (!p) {
    p = (async () => {
      const pool = listMoves(reg);
      const chain = await chainMoveIds(speciesName);
      if (!chain) return { species: speciesName, verified: false, learnable: pool, unverified: [] };
      const covered = await movesWithLearnsetCoverage();
      const learnable: string[] = [];
      const unverified: string[] = [];
      for (const name of pool) {
        const move = Dex.moves.get(name);
        if (!move?.exists || !covered.has(move.id)) unverified.push(name);
        else if (chain.has(move.id)) learnable.push(name);
      }
      return { species: speciesName, verified: true, learnable, unverified };
    })();
    learnsetCache.set(key, p);
    p.catch(() => learnsetCache.delete(key));
  }
  return p;
}

/** Human-readable learnset violations for a moveset, with the graft's provenance stated. */
export async function learnsetIssues(speciesName: string, moves: string[]): Promise<string[]> {
  const issues: string[] = [];
  for (const m of moves) {
    if (!m) continue;
    if ((await canLearn(speciesName, m)) === 'no') {
      issues.push(
        `${speciesName} cannot learn ${m} (per Gen 9 Showdown learnset data, grafted onto Champions).`,
      );
    }
  }
  return issues;
}
