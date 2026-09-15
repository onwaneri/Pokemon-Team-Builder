'use client';

/**
 * Chat state for the assistant panel.
 *
 * Lives in Workspace so the conversation and the action handler outlive tab switches. Each team
 * has its own conversation: `threadKey` (the saved team's id, or the draft key for an unsaved
 * team) selects which thread is live, and every thread is persisted per browser through
 * `lib/chat/threads`. Switching teams swaps the thread in place; a reply that lands after a
 * switch is filed under the team it was asked about, never the one now open. Immediate actions
 * (navigation, calc/speed/team edits) are applied as soon as the reply lands; proposal cards stay
 * attached to their message for the user to accept or reject.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { loadThread, saveThread, appendToThread } from '@/lib/chat/threads';
import type { TeamMon } from '@/lib/benchmarks/types';
import type { RulesetId } from '@/lib/rulesets';
import { aiFetch, readJson } from '@/lib/aiFetch';
import type {
  ChatAction,
  ScreenContext,
  ProposeTeamEditAction,
  ProposeBenchmarkAction,
  ProposeSubstitutionAction,
} from '@/lib/ai/types';

export interface ToolInvocationSummary { name: string; result: unknown }

export interface ChatMsg {
  role: 'user' | 'model';
  text: string;
  toolCalls?: ToolInvocationSummary[];
  proposals?: ProposeTeamEditAction[];
  dismissedProposals?: Set<number>;
  benchmarkProposals?: ProposeBenchmarkAction[];
  dismissedBenchmarks?: Set<string>;
  substitutionProposals?: ProposeSubstitutionAction[];
  dismissedSubstitutions?: Set<string>;
}

const PROPOSAL_TYPES = new Set(['proposeTeamEdit', 'proposeBenchmark', 'proposeSubstitution']);

export function useChampionsChat(opts: {
  team: TeamMon[] | null;
  getContext: () => ScreenContext;
  onAction: (action: ChatAction) => void;
  regulation: RulesetId;
  /** Which team's conversation is live (saved id, or the draft key). */
  threadKey: string;
}) {
  const { threadKey } = opts;
  // The thread is state keyed by the team it belongs to; when the key changes, the matching
  // stored conversation is swapped in during render (React's "adjust state on prop change").
  const [thread, setThread] = useState<{ key: string; messages: ChatMsg[] }>(() => ({ key: threadKey, messages: loadThread(threadKey) }));
  if (thread.key !== threadKey) setThread({ key: threadKey, messages: loadThread(threadKey) });
  const messages = thread.key === threadKey ? thread.messages : loadThread(threadKey);
  const setMessages: Dispatch<SetStateAction<ChatMsg[]>> = (update) =>
    setThread((t) => ({ key: t.key, messages: typeof update === 'function' ? update(t.messages) : update }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist the live thread whenever it changes.
  useEffect(() => { saveThread(thread.key, thread.messages); }, [thread]);

  // Refs so `send` always sees the latest callbacks/team/thread without being recreated.
  const optsRef = useRef(opts);
  const threadRef = useRef(thread);
  useEffect(() => {
    optsRef.current = opts;
    threadRef.current = thread;
  });

  /** Append a reply to the thread it belongs to: live state if still open, storage otherwise. */
  function fileReply(key: string, reply: ChatMsg) {
    if (threadRef.current.key === key) setMessages((m) => [...m, reply]);
    else appendToThread(key, reply);
  }

  async function send(text: string): Promise<void> {
    const q = text.trim();
    if (!q || loading) return;
    setError(null);
    const key = threadRef.current.key;
    const next: ChatMsg[] = [...threadRef.current.messages, { role: 'user', text: q }];
    setMessages(next);
    setLoading(true);
    try {
      const { team, getContext, onAction, regulation } = optsRef.current;
      const r = await aiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, text: m.text })),
          team: team ?? undefined,
          context: getContext(),
          regulation,
        }),
      });
      const data = await readJson<{ error?: string; text?: string; actions?: ChatAction[]; toolCalls?: ToolInvocationSummary[] }>(r);
      if (!r.ok) {
        if (threadRef.current.key === key) setError(data.error ?? 'Chat failed.');
        return;
      }
      const actions: ChatAction[] = data.actions ?? [];
      const proposals = actions.filter((a): a is ProposeTeamEditAction => a.type === 'proposeTeamEdit');
      const benchmarkProposals = actions.filter((a): a is ProposeBenchmarkAction => a.type === 'proposeBenchmark');
      const substitutionProposals = actions.filter((a): a is ProposeSubstitutionAction => a.type === 'proposeSubstitution');
      // Immediate actions edit the open screen, so they only apply while that team is still open.
      if (threadRef.current.key === key) for (const action of actions) if (!PROPOSAL_TYPES.has(action.type)) onAction(action);
      const reply: ChatMsg = {
        role: 'model',
        text: data.text ?? '',
        toolCalls: data.toolCalls,
        proposals: proposals.length ? proposals : undefined,
        benchmarkProposals: benchmarkProposals.length ? benchmarkProposals : undefined,
        substitutionProposals: substitutionProposals.length ? substitutionProposals : undefined,
      };
      fileReply(key, reply);
    } catch (e) {
      if (threadRef.current.key === key) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return { messages, setMessages, loading, error, send };
}
