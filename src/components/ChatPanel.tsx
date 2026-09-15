'use client';

/**
 * Chat panel — the single assistant surface. Renders the shared conversation (state lives in
 * Workspace via useChampionsChat) and the proposal cards. Whatever is typed goes out with the
 * current screen state attached, so it can answer questions or edit whichever screen is open;
 * the placeholder hints at what that screen accepts.
 */
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { TeamMon } from '@/lib/benchmarks/types';
import type { ChatAction, ProposeTeamEditAction, ProposeBenchmarkAction, ProposeSubstitutionAction, WorkspaceView } from '@/lib/ai/types';
import type { ChatMsg } from '@/hooks/useChampionsChat';

type Msg = ChatMsg;

const PLACEHOLDER: Record<WorkspaceView, string> = {
  team: 'Ask, or change anything… e.g. "give Garchomp a Life Orb and max Speed", "swap slots 1 and 3", "replace slot 5 with Rillaboom"',
  calc: 'Ask, or change anything… e.g. "set the defender to Incineroar", "swap sides and turn on Rain", "attacker at +2 SpA… run all moves"',
  speed: 'Ask, or change anything… e.g. "add slot 2 and Dragonite-Mega", "turn on Trick Room", "put Garchomp at −1 and paralyzed"',
};

export default function ChatPanel({
  team,
  teamName,
  view,
  onAction,
  isOpen,
  onToggle,
  messages,
  setMessages,
  loading,
  error,
  onSend,
}: {
  team: TeamMon[] | null;
  /** Shown under the title: every team has its own conversation. */
  teamName: string;
  view: WorkspaceView;
  onAction: (action: ChatAction) => void;
  isOpen: boolean;
  onToggle: () => void;
  messages: Msg[];
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  loading: boolean;
  error: string | null;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view whenever the thread grows.
  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
  }, [messages.length, loading]);

  function send(text: string) {
    const q = text.trim();
    if (!q || loading) return;
    setInput('');
    onSend(q);
  }

  function acceptProposal(msgIdx: number, proposal: ProposeTeamEditAction) {
    onAction(proposal);
    dismissProposal(msgIdx, proposal.slot);
  }
  function dismissProposal(msgIdx: number, slot: number) {
    setMessages((prev) => prev.map((m, i) => {
      if (i !== msgIdx) return m;
      const dismissed = new Set(m.dismissedProposals ?? []);
      dismissed.add(slot);
      return { ...m, dismissedProposals: dismissed };
    }));
  }
  function acceptBenchmark(msgIdx: number, proposal: ProposeBenchmarkAction) {
    onAction(proposal);
    dismissBenchmark(msgIdx, `${proposal.slot}-${proposal.description}`);
  }
  function acceptSubstitution(msgIdx: number, proposal: ProposeSubstitutionAction) {
    onAction(proposal);
    dismissSubstitution(msgIdx, `${proposal.slot}-${proposal.species}`);
  }
  function dismissSubstitution(msgIdx: number, key: string) {
    setMessages((prev) => prev.map((m, i) => {
      if (i !== msgIdx) return m;
      const dismissed = new Set(m.dismissedSubstitutions ?? []);
      dismissed.add(key);
      return { ...m, dismissedSubstitutions: dismissed };
    }));
  }

  function dismissBenchmark(msgIdx: number, key: string) {
    setMessages((prev) => prev.map((m, i) => {
      if (i !== msgIdx) return m;
      const dismissed = new Set(m.dismissedBenchmarks ?? []);
      dismissed.add(key);
      return { ...m, dismissedBenchmarks: dismissed };
    }));
  }

  const mdComponents = {
    p: ({ children }: React.PropsWithChildren) => <p style={{ margin: '0 0 6px 0', lineHeight: 1.55, fontSize: 12, color: '#c0c0e4' }}>{children}</p>,
    strong: ({ children }: React.PropsWithChildren) => <strong style={{ color: '#e4e4f8', fontWeight: 700 }}>{children}</strong>,
    em: ({ children }: React.PropsWithChildren) => <em style={{ color: '#a0a0d0' }}>{children}</em>,
    h1: ({ children }: React.PropsWithChildren) => <h1 style={{ fontSize: 14, fontWeight: 900, color: '#e4e4f8', margin: '10px 0 4px', lineHeight: 1.3 }}>{children}</h1>,
    h2: ({ children }: React.PropsWithChildren) => <h2 style={{ fontSize: 13, fontWeight: 800, color: '#e4e4f8', margin: '9px 0 4px', lineHeight: 1.3 }}>{children}</h2>,
    h3: ({ children }: React.PropsWithChildren) => <h3 style={{ fontSize: 12, fontWeight: 800, color: '#c8c8f0', margin: '8px 0 3px', lineHeight: 1.3 }}>{children}</h3>,
    ul: ({ children }: React.PropsWithChildren) => <ul style={{ paddingLeft: 16, margin: '4px 0', listStyleType: 'disc' }}>{children}</ul>,
    ol: ({ children }: React.PropsWithChildren) => <ol style={{ paddingLeft: 16, margin: '4px 0' }}>{children}</ol>,
    li: ({ children }: React.PropsWithChildren) => <li style={{ fontSize: 12, color: '#c0c0e4', margin: '2px 0', lineHeight: 1.5 }}>{children}</li>,
    code: ({ children, className }: React.PropsWithChildren<{ className?: string }>) =>
      className ? (
        <pre style={{ background: 'rgba(4,4,14,0.8)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 6, padding: '8px 10px', overflowX: 'auto', margin: '6px 0' }}>
          <code style={{ fontFamily: "'Courier New', monospace", fontSize: 11, color: '#a0c4ff' }}>{children}</code>
        </pre>
      ) : (
        <code style={{ fontFamily: "'Courier New', monospace", fontSize: 11, background: 'rgba(99,102,241,0.15)', padding: '1px 5px', borderRadius: 3, color: '#a0c4ff' }}>{children}</code>
      ),
    pre: ({ children }: React.PropsWithChildren) => <>{children}</>,
    hr: () => <hr style={{ border: 'none', borderTop: '1px solid rgba(99,102,241,0.2)', margin: '8px 0' }} />,
  };

  const containerStyle: React.CSSProperties = {
    borderLeft: '1px solid rgba(99,102,241,0.16)',
    background: 'rgba(7,7,18,0.92)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
    transition: 'opacity 0.2s ease',
  };

  if (!isOpen) {
    return (
      <div style={{ ...containerStyle, alignItems: 'center', paddingTop: 14, gap: 12 }}>
        <button
          onClick={onToggle}
          title="Open AI Assistant"
          style={{
            background: 'rgba(99,102,241,0.1)',
            border: '1px solid rgba(99,102,241,0.22)',
            color: '#6366f1',
            cursor: 'pointer',
            padding: '10px 5px',
            borderRadius: 9,
            fontSize: 11,
            fontWeight: 800,
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            letterSpacing: '0.8px',
            width: 34,
          } as React.CSSProperties}
        >
          Chat
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...containerStyle, animation: 'slideInR 0.22s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', borderBottom: '1px solid rgba(99,102,241,0.14)', flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 900, color: '#e4e4f8', letterSpacing: '-0.3px' }}>AI Assistant</span>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', display: 'block', flexShrink: 0 }} />
          </div>
          <div title="Each team keeps its own conversation" style={{ fontSize: 10, fontWeight: 700, color: '#50508a', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {teamName}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {messages.length > 0 && (
            <button
              onClick={() => { if (!loading) setMessages([]); }}
              disabled={loading}
              title="Start a new conversation for this team"
              style={{ background: 'transparent', border: '1px solid rgba(99,102,241,0.2)', color: '#5050a0', cursor: loading ? 'not-allowed' : 'pointer', padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800, lineHeight: 1.4, opacity: loading ? 0.5 : 1 }}
            >
              New chat
            </button>
          )}
          <button
            onClick={onToggle}
            title="Collapse"
            style={{ background: 'rgba(99,102,241,0.09)', border: '1px solid rgba(99,102,241,0.2)', color: '#5050a0', cursor: 'pointer', padding: '3px 9px', borderRadius: 6, fontSize: 14, fontWeight: 700, lineHeight: 1 }}
          >
            ›
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>

        {messages.map((m, msgIdx) => (
          <div key={msgIdx} style={{ textAlign: m.role === 'user' ? 'right' : 'left' }}>
            {m.role === 'user' ? (
              <div style={{ display: 'inline-block', maxWidth: '92%', whiteSpace: 'pre-wrap', borderRadius: 10, padding: '8px 11px', fontSize: 12, background: '#6366f1', color: 'white' }}>
                {m.text}
              </div>
            ) : (
              <div style={{ borderRadius: 10, padding: '8px 11px', fontSize: 12, background: 'rgba(25,25,50,0.9)', color: '#c0c0e4', border: '1px solid rgba(99,102,241,0.14)' }}>
                <ReactMarkdown components={mdComponents}>{m.text}</ReactMarkdown>
              </div>
            )}
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: '#40406a' }}>
                ⚙ ran {m.toolCalls.map((t) => t.name).join(', ')}
              </div>
            )}
            {m.proposals?.map((proposal) => {
              if (m.dismissedProposals?.has(proposal.slot)) return null;
              const current = team?.find((t) => t.slot === proposal.slot);
              return (
                <ProposalCard key={proposal.slot} proposal={proposal} current={current} onAccept={() => acceptProposal(msgIdx, proposal)} onReject={() => dismissProposal(msgIdx, proposal.slot)} />
              );
            })}
            {m.benchmarkProposals?.map((proposal) => {
              const key = `${proposal.slot}-${proposal.description}`;
              if (m.dismissedBenchmarks?.has(key)) return null;
              const monLabel = team?.find((t) => t.slot === proposal.slot)?.species ?? `Slot ${proposal.slot}`;
              return (
                <BenchmarkProposalCard key={key} proposal={proposal} monLabel={monLabel} onAccept={() => acceptBenchmark(msgIdx, proposal)} onReject={() => dismissBenchmark(msgIdx, key)} />
              );
            })}
            {m.substitutionProposals?.map((proposal) => {
              const key = `${proposal.slot}-${proposal.species}`;
              if (m.dismissedSubstitutions?.has(key)) return null;
              const currentSpecies = team?.find((t) => t.slot === proposal.slot)?.species ?? null;
              return (
                <SubstitutionProposalCard key={key} proposal={proposal} currentSpecies={currentSpecies} onAccept={() => acceptSubstitution(msgIdx, proposal)} onReject={() => dismissSubstitution(msgIdx, key)} />
              );
            })}
          </div>
        ))}

        {loading && <div style={{ fontSize: 12, color: '#40406a', fontStyle: 'italic' }}>Thinking…</div>}
        {error && (
          <div style={{ borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(239,68,68,0.07)', padding: '8px 11px', fontSize: 11, color: '#fca5a5' }}>
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(99,102,241,0.14)', flexShrink: 0 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          style={{ display: 'flex', gap: 6 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={PLACEHOLDER[view]}
            aria-label="Ask the assistant, or tell it what to change on this screen"
            style={{ flex: 1, minWidth: 0, background: 'rgba(4,4,14,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 9, padding: '8px 11px', fontSize: 12, color: '#c0c0e4', outline: 'none', fontWeight: 600, colorScheme: 'dark' } as React.CSSProperties}
          />
          <button
            type="submit"
            disabled={loading}
            style={{ padding: '8px 15px', borderRadius: 9, background: '#6366f1', color: 'white', border: 'none', fontSize: 12, fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', opacity: loading ? 0.6 : 1 }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function ProposalCard({ proposal, current, onAccept, onReject }: { proposal: ProposeTeamEditAction; current: TeamMon | undefined; onAccept: () => void; onReject: () => void }) {
  const { changes, label, reason } = proposal;
  const diffs: { field: string; from: string; to: string }[] = [];
  if (changes.item !== undefined && changes.item !== current?.item) diffs.push({ field: 'Item', from: current?.item ?? '—', to: changes.item });
  if (changes.ability !== undefined && changes.ability !== current?.ability) diffs.push({ field: 'Ability', from: current?.ability ?? '—', to: changes.ability });
  if (changes.nature !== undefined && changes.nature !== current?.nature) diffs.push({ field: 'Nature', from: current?.nature ?? '—', to: changes.nature });
  if (changes.moves !== undefined) {
    const oldMoves = (current?.moves ?? []).join(' / ');
    const newMoves = changes.moves.join(' / ');
    if (oldMoves !== newMoves) diffs.push({ field: 'Moves', from: oldMoves || '—', to: newMoves });
  }
  if (changes.sp !== undefined) {
    const fmtSp = (sp: Record<string, number>) => Object.entries(sp).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' / ') || '—';
    diffs.push({ field: 'SP', from: fmtSp((current?.sp ?? {}) as Record<string, number>), to: fmtSp(changes.sp as Record<string, number>) });
  }

  return (
    <div style={{ marginTop: 8, borderRadius: 10, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.07)', padding: 11, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#9090d0' }}>Proposed · {label}</span>
        <span style={{ fontSize: 10, color: '#40406a' }}>Slot {proposal.slot}</span>
      </div>
      {diffs.length > 0 ? (
        <div style={{ marginBottom: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {diffs.map((d) => (
            <div key={d.field} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: "'Courier New', monospace", fontSize: 10 }}>
              <span style={{ width: 48, flexShrink: 0, color: '#50508a' }}>{d.field}</span>
              <span style={{ color: '#f87171', textDecoration: 'line-through' }}>{d.from}</span>
              <span style={{ color: '#40406a' }}>→</span>
              <span style={{ color: '#34d399' }}>{d.to}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 11, color: '#50507a', marginBottom: 7 }}>No changes detected.</p>
      )}
      <p style={{ fontSize: 11, fontStyle: 'italic', color: '#50507a', marginBottom: 10 }}>{reason}</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onReject} style={{ padding: '4px 12px', borderRadius: 7, border: '1px solid rgba(99,102,241,0.2)', background: 'transparent', color: '#50507a', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>Reject</button>
        <button onClick={onAccept} style={{ padding: '4px 14px', borderRadius: 7, border: 'none', background: '#6366f1', color: 'white', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Accept</button>
      </div>
    </div>
  );
}

function SubstitutionProposalCard({ proposal, currentSpecies, onAccept, onReject }: {
  proposal: ProposeSubstitutionAction;
  currentSpecies: string | null;
  onAccept: () => void;
  onReject: () => void;
}) {
  const moves = proposal.moves.filter(Boolean);
  return (
    <div style={{ marginTop: 8, borderRadius: 10, border: '1px solid rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.07)', padding: 11, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#c084fc' }}>Substitution · Slot {proposal.slot}</span>
        {currentSpecies && (
          <span style={{ fontSize: 10, color: '#7c3aed', fontFamily: "'Courier New', monospace" }}>
            {currentSpecies} → {proposal.species}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        {currentSpecies && (
          <>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#7070a0', textDecoration: 'line-through' }}>{currentSpecies}</span>
            <span style={{ color: '#40406a', fontSize: 12 }}>→</span>
          </>
        )}
        <span style={{ fontSize: 15, fontWeight: 900, color: '#e4e4f8' }}>{proposal.species}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, fontFamily: "'Courier New', monospace", fontSize: 10, color: '#9090c0' }}>
        {proposal.ability && <div><span style={{ color: '#50508a' }}>Ability  </span>{proposal.ability}</div>}
        {proposal.item && <div><span style={{ color: '#50508a' }}>Item     </span>{proposal.item}</div>}
        {proposal.nature && <div><span style={{ color: '#50508a' }}>Nature   </span>{proposal.nature}</div>}
        {moves.length > 0 && <div><span style={{ color: '#50508a' }}>Moves    </span>{moves.join(' / ')}</div>}
      </div>
      <p style={{ fontSize: 11, fontStyle: 'italic', color: '#50507a', marginBottom: 10 }}>{proposal.reason}</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onReject} style={{ padding: '4px 12px', borderRadius: 7, border: '1px solid rgba(168,85,247,0.2)', background: 'transparent', color: '#50507a', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>Reject</button>
        <button onClick={onAccept} style={{ padding: '4px 14px', borderRadius: 7, border: 'none', background: 'rgba(168,85,247,0.7)', color: 'white', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Accept</button>
      </div>
    </div>
  );
}

function BenchmarkProposalCard({ proposal, monLabel, onAccept, onReject }: { proposal: ProposeBenchmarkAction; monLabel: string; onAccept: () => void; onReject: () => void }) {
  return (
    <div style={{ marginTop: 8, borderRadius: 10, border: '1px solid rgba(52,211,153,0.25)', background: 'rgba(16,185,129,0.06)', padding: 11, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399' }}>Benchmark · {monLabel}</span>
        <span style={{ fontSize: 10, color: '#40406a' }}>Slot {proposal.slot}</span>
      </div>
      <p style={{ fontFamily: "'Courier New', monospace", fontSize: 11, color: '#c0c0e4', marginBottom: 4 }}>&ldquo;{proposal.description}&rdquo;</p>
      <p style={{ fontSize: 11, fontStyle: 'italic', color: '#50507a', marginBottom: 10 }}>{proposal.reason}</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onReject} style={{ padding: '4px 12px', borderRadius: 7, border: '1px solid rgba(52,211,153,0.2)', background: 'transparent', color: '#50507a', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>Reject</button>
        <button onClick={onAccept} style={{ padding: '4px 14px', borderRadius: 7, border: 'none', background: 'rgba(16,185,129,0.7)', color: 'white', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Accept</button>
      </div>
    </div>
  );
}
