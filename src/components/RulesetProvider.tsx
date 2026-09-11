'use client';

/**
 * Active ruleset for the whole client. Every API call reads it from here and sends it along, so
 * switching the header selector re-scopes legality, usage data, comparison sets, the builder, and
 * the assistant without any screen needing to know the regulation's specifics. Persisted per
 * browser so the choice survives reloads.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_RULESET, isRulesetId, type RulesetId } from '@/lib/rulesets';

const STORAGE_KEY = 'vgc-champions-ruleset-v1';

interface RulesetContextValue {
  ruleset: RulesetId;
  setRuleset: (id: RulesetId) => void;
}

const RulesetContext = createContext<RulesetContextValue>({ ruleset: DEFAULT_RULESET, setRuleset: () => {} });

export function RulesetProvider({ children }: { children: ReactNode }) {
  const [ruleset, setRulesetState] = useState<RulesetId>(DEFAULT_RULESET);

  // Restore after mount so server and client render the same default (no hydration mismatch).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isRulesetId(stored)) {
        // Deferred so the restore never runs as a synchronous setState inside the effect body.
        const id = stored;
        queueMicrotask(() => setRulesetState(id));
      }
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);

  function setRuleset(id: RulesetId) {
    setRulesetState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* best-effort */
    }
  }

  return <RulesetContext.Provider value={{ ruleset, setRuleset }}>{children}</RulesetContext.Provider>;
}

export function useRuleset(): RulesetContextValue {
  return useContext(RulesetContext);
}
