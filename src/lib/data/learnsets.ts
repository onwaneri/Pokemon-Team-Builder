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

export async function canLearn(speciesName: string, moveName: string): Promise<LearnVerdict> {
  const move = Dex.moves.get(moveName);
  if (!move?.exists) return 'unknown';
  if (!(await movesWithLearnsetCoverage()).has(move.id)) return 'unknown';

  // Union the learnsets along the forme → base species → prevo chain (Megas carry no learnset of
  // their own; egg moves may only be recorded on earlier evolution stages).
  if (!Dex.species.get(speciesName)?.exists) return 'unknown';
  let current: string | undefined = speciesName;
  const seen = new Set<string>();
  while (current) {
    const sp = Dex.species.get(current);
    if (!sp?.exists || seen.has(sp.id)) break;
    seen.add(sp.id);
    const l = await Dex.learnsets.get(sp.id);
    if (l?.learnset?.[move.id]) return 'yes';
    current = sp.baseSpecies !== sp.name ? sp.baseSpecies : sp.prevo || undefined;
  }
  return 'no';
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
