/**
 * Team library data model.
 *
 * A SavedTeam is a snapshot of a 6-slot team (nulls for empty slots) plus metadata.
 * `blurb` is a short AI-generated overview; `blurbHash` tracks which composition the
 * blurb was generated from so we know when it is stale (see teamHash in store.ts).
 */
import type { TeamMon } from '@/lib/benchmarks/types';
import type { RulesetId } from '@/lib/rulesets';

export interface SavedTeam {
  /** Stable unique identifier — crypto.randomUUID() at creation time. */
  id: string;
  /** User-editable display name. */
  name: string;
  /** The six team slots; null = empty slot. */
  team: (TeamMon | null)[];
  /** AI-generated 2–3 sentence overview of how the team functions. '' when not yet generated. */
  blurb: string;
  /**
   * teamHash() value at the time the blurb was generated.
   * '' when the blurb has never been generated. Used to detect stale blurbs when the user
   * changes species / moves / items / SPs but hasn't regenerated yet.
   */
  blurbHash: string;
  /** Unix ms timestamp of initial save. */
  createdAt: number;
  /** Unix ms timestamp of most recent save or rename. */
  updatedAt: number;
  /** Ruleset active when the team was last saved. Absent on teams saved before rulesets existed. */
  regulation?: RulesetId;
}
