/**
 * Ruleset registry. To add a regulation: create `./<id>.ts` satisfying `Ruleset`, import it here,
 * add it to RULESETS. Everything else (legality, form lists, usage sources, the assistant's
 * context, the header selector) derives from this table.
 */
import type { Ruleset, RulesetId } from './types';
import { REG_M_B } from './reg-m-b';
import { REG_M_C } from './reg-m-c';

export type { Ruleset, RulesetId } from './types';

export const RULESETS: Record<RulesetId, Ruleset> = {
  'reg-m-b': REG_M_B,
  'reg-m-c': REG_M_C,
};

/** Selector order (newest last). */
export const RULESET_IDS: RulesetId[] = ['reg-m-b', 'reg-m-c'];

export const DEFAULT_RULESET: RulesetId = 'reg-m-c';

export function isRulesetId(v: unknown): v is RulesetId {
  return typeof v === 'string' && v in RULESETS;
}

/** Resolve a ruleset from untrusted input (request bodies, query strings, storage). */
export function getRuleset(id: unknown): Ruleset {
  return RULESETS[isRulesetId(id) ? id : DEFAULT_RULESET];
}
