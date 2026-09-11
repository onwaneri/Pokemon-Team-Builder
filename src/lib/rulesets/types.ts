/**
 * Ruleset contract.
 *
 * The app's substrate — the vendored Champions dex (gen 0), the calc engine, the SP system — never
 * changes per regulation. A ruleset is a *delta* applied on top of that substrate: what becomes
 * usable, what is banned, where usage data comes from, and what the assistant should know. Adding
 * a regulation means adding one file that satisfies this interface and registering it in
 * `./index.ts`; nothing else in the codebase should need to know the regulation's specifics.
 *
 * Client-safe: plain data, no engine or dex imports.
 */

export type RulesetId = 'reg-m-b' | 'reg-m-c';

export interface Ruleset {
  id: RulesetId;
  /** Full label for the selector, e.g. "Regulation M-C". */
  label: string;
  /** Short form used in prose, e.g. "Reg M-C". */
  short: string;
  /** Human-readable season window. */
  dates: string;
  /**
   * Pikalytics format codes to try, most specific first. A regulation whose data has not been
   * published yet lists its predecessor as a fallback; the UI is told when a fallback is serving.
   */
  pikalyticsFormats: string[];
  /** Species usable beyond the base Champions dex. Exact @pkmn/dex names (data is grafted from there). */
  addedSpecies: string[];
  /** Species removed from the pool. */
  bannedSpecies: string[];
  /** Items legal beyond the base gen-0 whitelist (include Mega Stones for any added Megas). */
  addedItems: string[];
  /** Items removed from the pool. */
  bannedItems: string[];
  /** Moves that exist in this regulation but not in the base gen-0 move table (data grafted from @pkmn/dex). */
  addedMoves: string[];
  /** Moves removed from the pool. */
  bannedMoves: string[];
  /**
   * Regulation-specific context for the model — qualitative only. Never put usage claims here;
   * usage is live data and comes from the usage tools.
   */
  notes: string;
}
