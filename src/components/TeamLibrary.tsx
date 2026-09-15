'use client';

/**
 * TeamLibrary — card grid view of all saved teams.
 *
 * Shown when Workspace is in 'library' mode (the initial view). Each card displays:
 *   - Editable team name (click-to-edit inline, commit on blur/Enter)
 *   - Row of up to 6 Pokémon sprites (hidden on 404 via onError)
 *   - AI blurb (shimmer while generating, "No overview yet" when absent)
 *   - Last-updated date
 *   - Actions: Open (primary), Export, Duplicate, Delete (two-step confirm)
 *
 * Header: title + count, Import Team + New Team buttons.
 * Empty state: centered CTA with the same two buttons.
 */

import { useState, type ReactNode } from 'react';
import type { SavedTeam } from '@/lib/library/types';
import { RULESETS } from '@/lib/rulesets';
import { Sprite } from '@/components/ui';

interface TeamLibraryProps {
  teams: SavedTeam[];
  pendingBlurbs: Set<string>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onExport: (team: SavedTeam) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Rendered between the header and the card grid (the Showdown panel). */
  aside?: ReactNode;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Individual team card ──────────────────────────────────────────────────────

interface CardProps {
  team: SavedTeam;
  isPending: boolean;
  onOpen: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}

function TeamCard({ team, isPending, onOpen, onExport, onDuplicate, onDelete, onRename }: CardProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(team.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blurbExpanded, setBlurbExpanded] = useState(false);

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== team.name) {
      onRename(trimmed);
    } else {
      setNameValue(team.name); // revert if empty or unchanged
    }
    setEditingName(false);
  }

  const filledMons = team.team.filter((m): m is NonNullable<typeof m> => m !== null);

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid rgba(99,102,241,0.2)',
        background: 'rgba(14,14,30,0.9)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Name row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {editingName ? (
          <input
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setNameValue(team.name); setEditingName(false); }
            }}
            autoFocus
            style={{
              flex: 1,
              background: 'rgba(5,5,15,0.9)',
              border: '1px solid rgba(99,102,241,0.4)',
              borderRadius: 6,
              padding: '3px 8px',
              color: '#eaeaf8',
              fontSize: 14,
              fontWeight: 700,
              outline: 'none',
              colorScheme: 'dark',
            } as React.CSSProperties}
          />
        ) : (
          <span
            role="button"
            tabIndex={0}
            onClick={() => setEditingName(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditingName(true); }}
            title="Click to rename"
            style={{
              flex: 1,
              fontSize: 14,
              fontWeight: 700,
              color: '#eaeaf8',
              cursor: 'text',
              userSelect: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {team.name}
          </span>
        )}
        {team.regulation && RULESETS[team.regulation] && (
          <span title={RULESETS[team.regulation].label} style={{ fontSize: 9, fontWeight: 800, color: '#8080c0', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 5, padding: '1px 6px', letterSpacing: '0.4px', flexShrink: 0 }}>
            {RULESETS[team.regulation].short}
          </span>
        )}
      </div>

      {/* Sprite row */}
      <div style={{ display: 'flex', gap: 2, alignItems: 'center', minHeight: 36 }}>
        {Array(6).fill(null).map((_, i) => {
          const mon = team.team[i];
          if (!mon) {
            return (
              <div
                key={i}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 6,
                  background: 'rgba(99,102,241,0.04)',
                  border: '1px dashed rgba(99,102,241,0.1)',
                }}
              />
            );
          }
          return (
            <Sprite
              key={i}
              species={mon.species}
              size={36}
              title={mon.nickname ? `${mon.nickname} (${mon.species})` : mon.species}
              style={{ flexShrink: 0 }}
            />
          );
        })}
        <span style={{ fontSize: 11, color: '#40406a', marginLeft: 4 }}>
          {filledMons.length}/6
        </span>
      </div>

      {/* Blurb */}
      <div style={{ minHeight: 36 }}>
        {isPending ? (
          <span
            style={{
              fontSize: 12,
              color: '#6366f1',
              fontStyle: 'italic',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          >
            Generating overview…
          </span>
        ) : team.blurb ? (
          <p
            role="button"
            tabIndex={0}
            onClick={() => setBlurbExpanded((e) => !e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBlurbExpanded((x) => !x); }
            }}
            title={blurbExpanded ? 'Click to collapse' : 'Click to read the full overview'}
            style={{
              fontSize: 12,
              color: blurbExpanded ? '#9090c0' : '#7070a0',
              margin: 0,
              lineHeight: 1.5,
              cursor: 'pointer',
              ...(blurbExpanded
                ? {}
                : {
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }),
            } as React.CSSProperties}
          >
            {team.blurb}
            {blurbExpanded && (
              <span style={{ color: '#48487a', fontSize: 11, fontStyle: 'italic' }}> — click to collapse</span>
            )}
          </p>
        ) : (
          <span style={{ fontSize: 12, color: '#3a3a5a', fontStyle: 'italic' }}>
            No overview yet
          </span>
        )}
      </div>

      {/* Updated date */}
      <div style={{ fontSize: 11, color: '#3a3a5a' }}>
        Updated {formatDate(team.updatedAt)}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={onOpen}
          style={{
            padding: '5px 14px',
            borderRadius: 7,
            background: '#6366f1',
            color: 'white',
            border: 'none',
            fontSize: 12,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          Open
        </button>
        <button
          onClick={onExport}
          style={{
            padding: '5px 12px',
            borderRadius: 7,
            border: '1px solid rgba(99,102,241,0.22)',
            background: 'rgba(99,102,241,0.07)',
            color: '#7070a0',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Export
        </button>
        <button
          onClick={onDuplicate}
          style={{
            padding: '5px 12px',
            borderRadius: 7,
            border: '1px solid rgba(99,102,241,0.22)',
            background: 'rgba(99,102,241,0.07)',
            color: '#7070a0',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Duplicate
        </button>

        {/* Two-step delete confirm */}
        {confirmDelete ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#f87171' }}>Delete?</span>
            <button
              onClick={() => { setConfirmDelete(false); onDelete(); }}
              style={{
                padding: '3px 8px',
                borderRadius: 5,
                background: '#7f1d1d',
                border: '1px solid rgba(248,113,113,0.3)',
                color: '#fca5a5',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ✓
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                padding: '3px 8px',
                borderRadius: 5,
                background: 'transparent',
                border: '1px solid rgba(99,102,241,0.22)',
                color: '#50507a',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ✗
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              padding: '5px 12px',
              borderRadius: 7,
              border: '1px solid rgba(248,113,113,0.18)',
              background: 'transparent',
              color: '#7a4040',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main library component ────────────────────────────────────────────────────

export default function TeamLibrary({
  teams,
  pendingBlurbs,
  onOpen,
  onNew,
  onImport,
  onExport,
  onDuplicate,
  onDelete,
  onRename,
  aside,
}: TeamLibraryProps) {
  return (
    <div className="m-tight" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div className="m-wrap" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 17, fontWeight: 900, color: '#eaeaf8', letterSpacing: '-0.3px' }}>
          Team Library
        </span>
        <span style={{ fontSize: 12, color: '#40406a', fontWeight: 600 }}>
          {teams.length} team{teams.length !== 1 ? 's' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onImport}
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid rgba(99,102,241,0.22)',
            background: 'rgba(99,102,241,0.07)',
            color: '#7070a0',
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          Import Team
        </button>
        <button
          onClick={onNew}
          style={{
            padding: '6px 16px',
            borderRadius: 8,
            background: '#6366f1',
            color: 'white',
            border: 'none',
            fontSize: 12,
            fontWeight: 800,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          New Team
        </button>
      </div>

      {aside}

      {/* Card grid or empty state */}
      {teams.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            borderRadius: 14,
            border: '1.5px dashed rgba(99,102,241,0.2)',
            background: 'rgba(12,12,28,0.5)',
            padding: 40,
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 14, color: '#48488a', margin: 0 }}>No saved teams yet.</p>
          <p style={{ fontSize: 12, color: '#3a3a5a', margin: 0 }}>
            Build a team from scratch or import a Showdown paste to get started.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onNew}
              style={{
                padding: '7px 20px',
                borderRadius: 8,
                background: '#6366f1',
                color: 'white',
                border: 'none',
                fontSize: 13,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              New Team
            </button>
            <button
              onClick={onImport}
              style={{
                padding: '7px 16px',
                borderRadius: 8,
                border: '1px solid rgba(99,102,241,0.22)',
                background: 'transparent',
                color: '#7070a0',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Import Team
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {teams.map((t) => (
            <TeamCard
              key={t.id}
              team={t}
              isPending={pendingBlurbs.has(t.id)}
              onOpen={() => onOpen(t.id)}
              onExport={() => onExport(t)}
              onDuplicate={() => onDuplicate(t.id)}
              onDelete={() => onDelete(t.id)}
              onRename={(name) => onRename(t.id, name)}
            />
          ))}
        </div>
      )}

      {/* Pulse animation for blurb shimmer */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
