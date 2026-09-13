'use client';

/**
 * Team builder controls on the Team tab, shown while slots are still open.
 *
 * With an empty team it builds from a short description; with a few Pokémon placed it fills the
 * remaining slots around them (those stay locked). The build runs as three bounded phases, one
 * per request (plan → draft → refine, see /api/build-team): the panel keeps calling with the
 * signed state it gets back and shows what each phase did, so nothing depends on a long-lived
 * request. The result is applied straight to the team; Workspace keeps the previous slots for Undo.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TeamMon } from '@/lib/benchmarks/types';
import { useRuleset } from '@/components/RulesetProvider';
import { aiFetch, readJson } from '@/lib/aiFetch';

type TeamSlot = TeamMon | null;

const EXAMPLES_EMPTY = ['rain with a Trick Room mode', 'hyper offense around Dragonite-Mega Tailwind', 'balanced, Fake Out support, two speed-control options'];
const EXAMPLES_PARTIAL = ['keep it standard, cover Fairy and Ice', 'add a Trick Room mode as the backup plan', 'add redirection and a second special attacker'];

interface StepResponse {
  state: string | null;
  progress?: string;
  round?: number;
  done: { team: TeamSlot[]; summary: string } | null;
  error?: string;
}

export default function TeamBuilderPanel({
  team,
  onBuilt,
}: {
  team: TeamSlot[];
  onBuilt: (result: { team: TeamSlot[]; summary: string }) => void;
}) {
  const { ruleset } = useRuleset();
  const filled = team.filter((m): m is TeamMon => m !== null);
  const open = 6 - filled.length;
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  if (open === 0) return null;

  async function build(e?: FormEvent) {
    e?.preventDefault();
    if (running) return;
    cancelled.current = false;
    setRunning(true);
    setError(null);
    setProgress(['starting']);
    try {
      let body: Record<string, unknown> = { prompt, team, regulation: ruleset };
      let retries = 0;
      for (let i = 0; i < 60; i++) {
        let r: Response;
        let data: StepResponse & { error?: string };
        try {
          r = await aiFetch('/api/build-team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          data = await readJson<StepResponse>(r);
        } catch (err) {
          // Network failure mid-build: treat like a platform error below.
          r = new Response(null, { status: 599 });
          data = { state: null, progress: '', done: null, error: (err as Error).message };
        }
        if (cancelled.current) return;
        // A round the platform killed (function timeout page, 502/504, dropped connection) is safe to
        // redo: continuing rounds are idempotent and never re-charged, and the first round is only
        // charged once the server actually answers. Retry twice before giving up.
        const platformFailure = r.status >= 500 || r.status === 599;
        if (platformFailure && retries < 2) {
          retries += 1;
          setProgress((p) => [...p.filter((x) => x !== 'starting'), `round timed out, retrying (${retries}/2)`].slice(-4));
          continue;
        }
        if (!r.ok) { setError(data.error ?? 'Team build failed.'); return; }
        retries = 0;
        setProgress((p) => [...p.filter((x) => x !== 'starting'), data.progress ?? 'thinking'].slice(-4));
        if (data.done) {
          onBuilt(data.done);
          setPrompt('');
          setProgress([]);
          return;
        }
        if (!data.state) { setError('The build stopped without a result.'); return; }
        body = { state: data.state };
      }
      setError('The build took too many rounds. Try a more specific description.');
    } catch (err) {
      if (!cancelled.current) setError((err as Error).message);
    } finally {
      if (!cancelled.current) setRunning(false);
    }
  }

  function cancel() {
    cancelled.current = true;
    setRunning(false);
    setProgress([]);
  }

  const examples = filled.length === 0 ? EXAMPLES_EMPTY : EXAMPLES_PARTIAL;
  const label = filled.length === 0 ? 'Build team' : `Fill the other ${open}`;

  return (
    <div style={{ borderRadius: 12, border: '1px solid rgba(99,102,241,0.18)', background: 'rgba(12,12,28,0.85)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <form onSubmit={build} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={filled.length === 0 ? 'What kind of team? e.g. "sun team, I like Incineroar"' : `Fills ${open} slot${open > 1 ? 's' : ''} around ${filled.map((m) => m.species).join(', ')} · optional notes`}
          disabled={running}
          aria-label="Team description"
          style={{ flex: 1, minWidth: 0, background: 'rgba(4,4,14,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 9, padding: '8px 11px', fontSize: 12, color: '#d0d0f0', outline: 'none', fontWeight: 600, colorScheme: 'dark' } as React.CSSProperties}
        />
        {running ? (
          <button type="button" onClick={cancel} style={{ padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a8', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Cancel
          </button>
        ) : (
          <button type="submit" style={{ padding: '7px 16px', borderRadius: 9, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {label}
          </button>
        )}
      </form>

      {running ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8a8ab8', minHeight: 16 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(99,102,241,0.25)', borderTopColor: '#6366f1', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress[progress.length - 1] ?? 'starting'}</span>
        </div>
      ) : error ? (
        <div style={{ fontSize: 11, color: '#f87171', lineHeight: 1.5 }}>{error}</div>
      ) : (
        <div style={{ fontSize: 11, color: '#50507a', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span>Try:</span>
          {examples.map((ex, i) => (
            <button key={ex} type="button" onClick={() => setPrompt(ex)} style={{ background: 'none', border: 'none', padding: 0, color: '#7070a8', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
              {ex}{i < examples.length - 1 ? ',' : ''}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', color: '#40406a' }}>every slot stays editable</span>
        </div>
      )}
    </div>
  );
}
