/**
 * Regulation M-B — the baseline. The vendored gen-0 dex *is* the Reg M-B pool, so this delta is
 * empty; it exists so the regulation is a first-class, selectable ruleset like any other.
 * Ground truth: context/ground-truth-reg-mb.md.
 */
import type { Ruleset } from './types';

export const REG_M_B: Ruleset = {
  id: 'reg-m-b',
  label: 'Regulation M-B',
  short: 'Reg M-B',
  dates: 'through September 8, 2026',
  pikalyticsFormats: ['gen9championsvgc2026regmb'],
  addedSpecies: [],
  bannedSpecies: [],
  addedItems: [],
  bannedItems: [],
  addedMoves: [],
  bannedMoves: [],
  notes: '',
};
