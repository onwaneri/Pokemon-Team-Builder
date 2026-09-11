import { formLists, type FormLists } from '@/lib/data/champions';
import { RULESET_IDS, type RulesetId } from '@/lib/rulesets';
import { RulesetProvider } from '@/components/RulesetProvider';
import { AuthProvider } from '@/components/AuthProvider';
import AppShell from '@/components/AppShell';

export default function Home() {
  // One set of dropdown lists per ruleset, computed on the server so switching regulations in the
  // header is instant and never re-fetches the dex.
  const listsByRuleset = Object.fromEntries(RULESET_IDS.map((id) => [id, formLists(id)])) as Record<RulesetId, FormLists>;

  return (
    <AuthProvider>
      <RulesetProvider>
        <AppShell listsByRuleset={listsByRuleset} />
      </RulesetProvider>
    </AuthProvider>
  );
}
