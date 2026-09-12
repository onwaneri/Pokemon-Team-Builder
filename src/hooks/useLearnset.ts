'use client';

/**
 * Per-species learnset for the move pickers, plus the helper that turns it (and usage data) into
 * Showdown-style sections: common moves first, the rest of the learnset alphabetically, then
 * anything the dex can't vouch for, and finally moves outside the learnset only when searched.
 */
import { useState, useEffect, useRef } from 'react';
import type { SpeciesLearnset } from '@/lib/data/learnsets';
import type { UsageEntry } from '@/lib/data/usage';
import type { ComboboxOption } from '@/components/Combobox';
import { useRuleset } from '@/components/RulesetProvider';

const cache = new Map<string, SpeciesLearnset>();

export function useLearnset(species: string) {
  const { ruleset } = useRuleset();
  const key = `${ruleset}:${species}`;
  const [data, setData] = useState<SpeciesLearnset | null>(() => cache.get(key) ?? null);
  const lastFetched = useRef<string>('');

  useEffect(() => {
    if (!species || key === lastFetched.current) return;
    lastFetched.current = key;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const hit = cache.get(key);
      setData(hit ?? null);
      if (hit) return;
      fetch(`/api/learnset?pokemon=${encodeURIComponent(species)}&regulation=${ruleset}`)
        .then((r) => (r.ok ? (r.json() as Promise<SpeciesLearnset>) : null))
        .then((d) => {
          if (!d) return;
          cache.set(key, d);
          if (!cancelled) setData(d);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      if (lastFetched.current === key) lastFetched.current = '';
    };
  }, [species, ruleset, key]);

  return { learnset: data && data.species === species ? data : null };
}

export interface MoveSections {
  options: ComboboxOption[];
  /** usage share per move, for the option rows. */
  pct: Map<string, number>;
  /** Moves the Gen 9 learnset positively excludes (still selectable via search). */
  notLearnable: Set<string>;
}

/**
 * Usage evidence outranks the learnset graft: a move Pikalytics sees on this species is legal in
 * Champions whatever Gen 9 says, so it always lands in "Common".
 */
export function moveOptionsFor(allMoves: string[], usageMoves: UsageEntry[] | undefined, learnset: SpeciesLearnset | null): MoveSections {
  const pool = new Set(allMoves);
  const pct = new Map<string, number>();
  const common: string[] = [];
  for (const e of usageMoves ?? []) {
    if (!pool.has(e.name) || pct.has(e.name)) continue;
    pct.set(e.name, e.pct);
    common.push(e.name);
  }
  const taken = new Set(common);
  const options: ComboboxOption[] = [];
  if (common.length) options.push({ header: 'Common', hint: 'by usage' }, ...common);

  if (!learnset) {
    options.push({ header: common.length ? 'All moves' : 'Moves' }, ...allMoves.filter((m) => !taken.has(m)));
    return { options, pct, notLearnable: new Set() };
  }

  const learnable = learnset.learnable.filter((m) => pool.has(m) && !taken.has(m));
  const unverified = learnset.unverified.filter((m) => pool.has(m) && !taken.has(m));
  for (const m of [...learnable, ...unverified]) taken.add(m);
  const notLearnable = allMoves.filter((m) => !taken.has(m));

  if (learnable.length) options.push({ header: learnset.verified ? 'Learnset' : 'All moves' }, ...learnable);
  if (unverified.length) options.push({ header: 'Unverified', hint: 'no learnset data' }, ...unverified);
  if (notLearnable.length) options.push({ header: 'Not in learnset', hint: 'per Gen 9 data', searchOnly: true }, ...notLearnable);
  return { options, pct, notLearnable: new Set(notLearnable) };
}
