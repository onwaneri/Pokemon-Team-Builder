'use client';

/**
 * Chat state for the assistant panel.
 *
 * Lives in Workspace so the conversation and the action handler outlive tab switches. Immediate
 * actions (navigation, calc/speed/team edits) are applied as soon as the reply lands; proposal
 * cards stay attached to their message for the user to accept or reject.
 */
import { useEffect, useRef, useState } from 'react';
import type { TeamMon } from '@/lib/benchmarks/types';
import type { RulesetId } from '@/lib/rulesets';
import { aiFetch } from '@/lib/aiFetch';
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
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so `send` always sees the latest callbacks/team/thread without being recreated.
  const optsRef = useRef(opts);
  const messagesRef = useRef(messages);
  useEffect(() => {
    optsRef.current = opts;
    messagesRef.current = messages;
  });

  async function send(text: string): Promise<void> {
    const q = text.trim();
    if (!q || loading) return;
    setError(null);
    const next: ChatMsg[] = [...messagesRef.current, { role: 'user', text: q }];
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
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? 'Chat failed.');
        return;
      }
      const actions: ChatAction[] = data.actions ?? [];
      const proposals = actions.filter((a): a is ProposeTeamEditAction => a.type === 'proposeTeamEdit');
      const benchmarkProposals = actions.filter((a): a is ProposeBenchmarkAction => a.type === 'proposeBenchmark');
      const substitutionProposals = actions.filter((a): a is ProposeSubstitutionAction => a.type === 'proposeSubstitution');
      for (const action of actions) if (!PROPOSAL_TYPES.has(action.type)) onAction(action);
      const reply: ChatMsg = {
        role: 'model',
        text: data.text ?? '',
        toolCalls: data.toolCalls,
        proposals: proposals.length ? proposals : undefined,
        benchmarkProposals: benchmarkProposals.length ? benchmarkProposals : undefined,
        substitutionProposals: substitutionProposals.length ? substitutionProposals : undefined,
      };
      setMessages((m) => [...m, reply]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return { messages, setMessages, loading, error, send };
}
