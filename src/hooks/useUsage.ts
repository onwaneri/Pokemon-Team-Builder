'use client';

import { useState, useEffect, useRef } from 'react';
import type { UsageData } from '@/lib/data/usage';
import type { ComboboxOption } from '@/components/Combobox';
import { useRuleset } from '@/components/RulesetProvider';

/** Usage data plus which Pikalytics format served it (a newer ruleset may be on fallback data). */
export type UsageWithSource = UsageData & { usageFormat?: string; usageFallbackFrom?: string | null };

export function useUsage(species: string) {
  const { ruleset } = useRuleset();
  const [data, setData] = useState<UsageWithSource | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetched = useRef<string>('');

  useEffect(() => {
    const key = `${ruleset}:${species}`;
    if (!species || key === lastFetched.current) return;
    lastFetched.current = key;
    let cancelled = false;
    // Fetch in a microtask so the effect body itself never calls setState synchronously.
    queueMicrotask(() => {
      if (cancelled) return;
      setData(null);
      setLoading(true);
      fetch(`/api/usage?pokemon=${encodeURIComponent(species)}&regulation=${ruleset}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    });
    return () => {
      cancelled = true;
      // A cancelled fetch never landed, so let the next run (StrictMode's re-mount included) redo it.
      if (lastFetched.current === key) lastFetched.current = '';
    };
  }, [species, ruleset]);

  return { usage: data, loadingUsage: loading };
}

export function usageSortedItems(items: string[], usageItems: UsageData['items']): ComboboxOption[] {
  if (!usageItems?.length) return items;
  const topValid = usageItems.map((e) => e.name).filter((n) => items.includes(n));
  if (!topValid.length) return items;
  const rest = items.filter((n) => !topValid.includes(n));
  return [{ header: 'Common', hint: 'by usage' }, ...topValid, { header: 'Other items' }, ...rest];
}
