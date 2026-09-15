'use client';

/**
 * Workspace — the root client component for Forge (the VGC Champions team builder).
 *
 * Two top-level modes:
 *   'library' — shows TeamLibrary full-width (initial state). Chat panel is hidden.
 *   'editor'  — existing team editor UI with tab bar + chat panel.
 *
 * The "← Library" button in editor mode navigates back. If there are unsaved changes
 * (teamHash(team) !== savedHash), a save-prompt modal intercepts the navigation so
 * nothing is silently discarded. Save / Export / Import live in the toolbar's ⋯ menu; the
 * team name is edited inline in the toolbar and the first Save uses it as-is.
 *
 * Team persistence is handled through teamStore (localStorage, async interface) so a
 * Firestore adapter can be dropped in without touching this file.
 *
 * Blurb generation fires automatically on save when the composition has changed since
 * the last blurb was created (blurbHash mismatch). It runs in the background without
 * blocking the UI; pendingBlurbs tracks which team IDs are waiting on a response.
 */

import { useState, useEffect, useRef, type ReactNode } from 'react';
import DamageCalcView, { DEFAULT_CALC_STATE } from '@/components/DamageCalcView';
import TeamView from '@/components/TeamView';
import SpeedTierView, { DEFAULT_SPEED_STATE, mineEntry, oppEntry } from '@/components/SpeedTierView';
import ChatPanel from '@/components/ChatPanel';
import TeamBuilderPanel from '@/components/TeamBuilderPanel';
import TeamLibrary from '@/components/TeamLibrary';
import ShareButtons from '@/components/showdown/ShareButtons';
import { useChampionsChat } from '@/hooks/useChampionsChat';
import { DRAFT_THREAD, moveThread, deleteThread } from '@/lib/chat/threads';
import { useRuleset } from '@/components/RulesetProvider';
import { RULESETS } from '@/lib/rulesets';
import type { FormLists } from '@/lib/data/champions';
import type { TeamMon, Benchmark } from '@/lib/benchmarks/types';
import type {
  ChatAction,
  CalcMonSet,
  CalcScreenState,
  SpeedScreenState,
  SpeedEntryState,
  ScreenContext,
  WorkspaceView,
  UpdateCalcAction,
  UpdateSpeedTierAction,
} from '@/lib/ai/types';
import { calcChampionsStats, ZERO_STATS, type SpSpread, natureIssue, isCompleteNature } from '@/lib/calc/sp';
import { padMoves } from '@/lib/moves';
import { teamStore as localTeamStore, teamHash } from '@/lib/library/store';
import { useAuth } from '@/components/AuthProvider';
import { aiFetch } from '@/lib/aiFetch';
import { exportTeamPaste } from '@/lib/showdown/export';
import { useIsMobile } from '@/hooks/useIsMobile';
import { suggestTeamNames, isPlaceholderName } from '@/lib/library/teamNames';
import type { SavedTeam } from '@/lib/library/types';

interface LegalityIssue { message: string }

type TeamSlot = TeamMon | null;

/** Build a fresh TeamMon (no nickname, role, or benchmarks) from a set, computing its stats. */
function monFromSet(slot: number, set: Partial<CalcMonSet> & { species: string }, lists: FormLists): TeamMon {
  const sp = set.sp ?? {};
  const nature = set.nature || 'Hardy';
  const base = lists.speciesStats[set.species];
  return {
    slot,
    nickname: null,
    species: set.species,
    item: set.item ?? '',
    ability: set.ability ?? '',
    nature,
    sp,
    moves: padMoves(set.moves),
    computedStats: base ? calcChampionsStats(base, sp, nature) : ZERO_STATS,
    role: '',
    benchmarks: [],
  };
}

/** Default legal set for a species picked in an empty slot. */
function makeMon(species: string, slot: number, lists: FormLists): TeamMon {
  return monFromSet(slot, { species, ability: lists.speciesAbilities[species]?.[0] ?? '' }, lists);
}

/** Normalize a set from the assistant into the 4-move shape the calc editor expects. */
function padSet(s: CalcMonSet): CalcMonSet {
  return { species: s.species, ability: s.ability ?? '', item: s.item ?? '', nature: s.nature || 'Hardy', sp: s.sp ?? {}, moves: padMoves(s.moves) };
}

/** Short Showdown paste for the import modal's "Use sample team" link. */
const SAMPLE_PASTE = `Incineroar @ Shell Bell
Ability: Intimidate
Level: 50
Adamant Nature
EVs: 32 HP / 2 Atk / 32 SpD
- Fake Out
- Knock Off
- Flare Blitz
- Parting Shot

Garchomp @ Life Orb
Ability: Rough Skin
Level: 50
Jolly Nature
EVs: 2 HP / 32 Atk / 32 Spe
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Dragonite-Mega @ Sitrus Berry
Ability: Multiscale
Level: 50
Modest Nature
EVs: 32 HP / 32 SpA / 2 SpD
- Hurricane
- Thunderbolt
- Tailwind
- Protect`;

export default function Workspace({ lists }: { lists: FormLists }) {
  const { ruleset } = useRuleset();
  const rules = RULESETS[ruleset];
  // Team persistence: localStorage as a guest, the user's Firestore library when signed in.
  const { store: teamStore, storeVersion, user } = useAuth();
  /** How many browser-saved teams were just moved into the account (a dismissible notice). */
  const [movedTeams, setMovedTeams] = useState(0);
  /** Last persistence failure (Firestore rules, network, quota) — shown in the toolbar until dismissed. */
  const [saveError, setSaveError] = useState<string | null>(null);

  // ─── Library / editor mode ─────────────────────────────────────────────────
  const [mode, setMode] = useState<'library' | 'editor'>('library');

  // ─── Library state ─────────────────────────────────────────────────────────
  const [savedTeams, setSavedTeams] = useState<SavedTeam[]>([]);
  const [pendingBlurbs, setPendingBlurbs] = useState<Set<string>>(new Set());

  // ─── Currently open team ───────────────────────────────────────────────────
  const [currentTeamId, setCurrentTeamId] = useState<string | null>(null);
  const [currentTeamName, setCurrentTeamName] = useState('Untitled Team');
  /** teamHash() of the team composition at the last save. null = never saved. */
  const [savedHash, setSavedHash] = useState<string | null>(null);

  // ─── Editor state ──────────────────────────────────────────────────────────
  const [view, setView] = useState<WorkspaceView>('team');
  const [team, setTeam] = useState<TeamSlot[] | null>(null);
  const [issues, setIssues] = useState<LegalityIssue[]>([]);
  const [showImport, setShowImport] = useState(false);
  /** 'new' (from the library) starts an unsaved team; 'replace' (from the editor) swaps the open team's slots. */
  const [importTarget, setImportTarget] = useState<'new' | 'replace'>('new');
  const [paste, setPaste] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [reevaluating, setReevaluating] = useState<Set<number>>(new Set());
  // Open by default beside the editor; on a phone it is a full-screen sheet that starts closed.
  const isMobile = useIsMobile();
  const [chatOpenState, setChatOpen] = useState<boolean | null>(null);
  const chatOpen = chatOpenState ?? !isMobile;

  // ─── Screen state the assistant can read and edit ─────────────────────────
  // Damage Calc and Speed Tier settings live here (not in the views) so natural-language changes
  // can target them and they persist across tab switches.
  const [calcState, setCalcState] = useState<CalcScreenState>(DEFAULT_CALC_STATE);
  const [speedState, setSpeedState] = useState<SpeedScreenState>(DEFAULT_SPEED_STATE);
  /** Bumped when the assistant asks the calc to run every move. */
  const [calcRunToken, setCalcRunToken] = useState(0);

  // ─── AI team builder result banner (with undo) ────────────────────────────
  const [builderBanner, setBuilderBanner] = useState<{ summary: string; previous: TeamSlot[]; filled: number } | null>(null);

  // ─── Export modal ──────────────────────────────────────────────────────────
  const [exportPaste, setExportPaste] = useState<string | null>(null);
  const [copiedExport, setCopiedExport] = useState(false);

  // ─── Save-prompt modal ─────────────────────────────────────────────────────
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [savePromptName, setSavePromptName] = useState('');
  /** Name picker shown on the first save of a still-untitled team (and from the ✦ next to the name). */
  const [namePicker, setNamePicker] = useState<{ value: string; suggestions: string[]; then: 'save' | 'rename' } | null>(null);
  /** After save-prompt resolves, either go to library or do nothing. */
  const [savePromptTarget, setSavePromptTarget] = useState<'library' | null>(null);

  // ─── Toolbar ⋯ menu ────────────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false);

  // ─── Load saved teams on mount ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    teamStore.list().then((teams) => {
      if (!cancelled) setSavedTeams([...teams].sort((a, b) => b.updatedAt - a.updatedAt));
    });
    // Signed in (or just created an account) with teams still in this browser → move them into the
    // account automatically. Same id already there means it was moved before: just drop the copy.
    if (user && teamStore !== localTeamStore) {
      (async () => {
        const local = await localTeamStore.list();
        if (!local.length) return;
        const existing = new Set((await teamStore.list()).map((t) => t.id));
        let moved = 0;
        for (const t of local) {
          try {
            if (!existing.has(t.id)) await teamStore.save(t);
            await localTeamStore.remove(t.id);
            moved++;
          } catch (e) {
            console.error('[migrate]', e);
            if (!cancelled) setSaveError(`Could not move "${t.name}" from this browser to your account; it is still saved here.`);
            break;
          }
        }
        if (cancelled || !moved) return;
        setMovedTeams(moved);
        const teams = await teamStore.list();
        if (!cancelled) setSavedTeams([...teams].sort((a, b) => b.updatedAt - a.updatedAt));
      })();
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeVersion]);

  // Imports handed over by the options menu's Showdown panel (it has no reference into here).
  useEffect(() => {
    const onPaste = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) doImport(text, 'new');
    };
    window.addEventListener('vgc:import-paste', onPaste);
    return () => window.removeEventListener('vgc:import-paste', onPaste);
  });

  // ─── Refresh helper ────────────────────────────────────────────────────────
  async function refreshTeams() {
    const teams = await teamStore.list();
    setSavedTeams([...teams].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  // ─── Blurb generation (fire-and-forget) ──────────────────────────────────
  async function generateBlurb(teamId: string, teamData: (TeamMon | null)[], hashAtRequest: string) {
    setPendingBlurbs((prev) => new Set([...prev, teamId]));
    try {
      const resp = await aiFetch('/api/team-blurb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team: teamData, regulation: ruleset }),
      });
      const data = (await resp.json()) as { blurb?: string };
      const blurb = data.blurb ?? '';

      // Re-fetch the current saved record so we don't clobber a rename that happened
      // while we were waiting for Gemini.
      const latest = await teamStore.get(teamId);
      if (latest) {
        const updated: SavedTeam = {
          ...latest,
          // Only update blurb/blurbHash; keep the blurb if response was empty
          blurb: blurb || latest.blurb,
          blurbHash: hashAtRequest,
        };
        await teamStore.save(updated);
      }
    } catch {
      // Best-effort; silently drop errors.
    } finally {
      setPendingBlurbs((prev) => {
        const next = new Set(prev);
        next.delete(teamId);
        return next;
      });
      await refreshTeams();
    }
  }

  // ─── Save flow ─────────────────────────────────────────────────────────────
  async function saveCurrentTeam(name: string) {
    if (!team) return;
    setSaveError(null);
    try {
      await persistCurrentTeam(name);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      const msg = code === 'permission-denied'
        ? 'Firestore rejected the save (permission denied). The team did not save.'
        : code === 'unavailable'
          ? 'Could not reach Firestore (offline or blocked network). The team did not save.'
          : `Save failed: ${(e as Error)?.message ?? String(e)}`;
      console.error('[save]', e);
      setSaveError(msg);
    }
  }

  async function persistCurrentTeam(name: string) {
    if (!team) return;
    const incomplete = team.filter((m): m is TeamMon => !!m && !isCompleteNature(m.nature));
    if (incomplete.length) throw new Error(`Finish the nature on ${incomplete.map((m) => m.species).join(', ')} first (a stat is raised or lowered without its pair).`);
    const now = Date.now();
    const hash = teamHash(team);
    let savedTeam: SavedTeam;

    if (currentTeamId) {
      // Update existing record — preserve createdAt and blurb.
      const existing = await teamStore.get(currentTeamId);
      savedTeam = {
        id: currentTeamId,
        name,
        team,
        blurb: existing?.blurb ?? '',
        blurbHash: existing?.blurbHash ?? '',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        regulation: ruleset,
      };
    } else {
      // New team — generate a fresh ID.
      savedTeam = {
        id: crypto.randomUUID(),
        name,
        team,
        blurb: '',
        blurbHash: '',
        createdAt: now,
        updatedAt: now,
        regulation: ruleset,
      };
      // The draft's conversation becomes this team's.
      moveThread(DRAFT_THREAD, savedTeam.id);
      setCurrentTeamId(savedTeam.id);
    }

    await teamStore.save(savedTeam);
    setCurrentTeamName(name);
    setSavedHash(hash);
    await refreshTeams();

    // Kick off blurb generation if the composition changed since the last blurb.
    if (hash !== savedTeam.blurbHash) {
      generateBlurb(savedTeam.id, team, hash);
    }
  }

  // ─── Library → editor navigation ──────────────────────────────────────────
  function openTeam(id: string) {
    const stored = savedTeams.find((t) => t.id === id);
    if (!stored) return;
    setTeam(structuredClone(stored.team));
    setCurrentTeamId(stored.id);
    setCurrentTeamName(stored.name);
    setSavedHash(teamHash(stored.team));
    setIssues([]);
    setBuilderBanner(null);
    setView('team');
    setMode('editor');
  }

  function startNew() {
    deleteThread(DRAFT_THREAD);
    setTeam(Array(6).fill(null));
    setCurrentTeamId(null);
    setCurrentTeamName('Untitled Team');
    setSavedHash(null);
    setIssues([]);
    setBuilderBanner(null);
    setView('team');
    setMode('editor');
  }

  function goToLibrary() {
    // If team is blank (null) or hash matches the last save → no unsaved changes.
    const currentHash = team ? teamHash(team) : null;
    if (!team || currentHash === savedHash) {
      setMode('library');
      return;
    }
    // Otherwise prompt; an untitled team gets a suggested name prefilled.
    setSavePromptName(isPlaceholderName(currentTeamName) ? (suggestTeamNames(team)[0] ?? currentTeamName) : currentTeamName);
    setSavePromptTarget('library');
    setShowSavePrompt(true);
  }

  // ─── Import (one modal, opened from the library or the editor's ⋯ menu) ────
  function openImportModal() {
    setPaste('');
    setError(null);
    setImportTarget(mode === 'library' ? 'new' : 'replace');
    setShowImport(true);
  }

  /**
   * Import a paste. Defaults to the modal's textarea + target; the Showdown panel passes its own
   * text and always creates a fresh team (it lives on the library page).
   */
  async function doImport(text: string = paste, target: 'new' | 'replace' = importTarget) {
    if (!text.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      const r = await aiFetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paste: text, regulation: ruleset }) });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? 'Import failed.');
      } else {
        const slots: TeamSlot[] = Array(6).fill(null);
        for (const m of data.team as TeamMon[]) { if (m.slot >= 1 && m.slot <= 6) slots[m.slot - 1] = m; }
        setTeam(slots);
        setIssues(data.issues ?? []);
        setIssuesExpanded(false);
        setBuilderBanner(null);
        setShowImport(false);
        if (target === 'new') {
          // Fresh, unsaved team (with a fresh conversation).
          deleteThread(DRAFT_THREAD);
          setCurrentTeamId(null);
          setCurrentTeamName('Untitled Team');
          setSavedHash(null);
        }
        setView('team');
        setMode('editor');
      }
    } catch (e) { setError((e as Error).message); }
    finally { setImporting(false); }
  }

  // ─── Library action handlers ───────────────────────────────────────────────
  async function handleDuplicate(id: string) {
    const src = savedTeams.find((t) => t.id === id);
    if (!src) return;
    const now = Date.now();
    const copy: SavedTeam = {
      ...structuredClone(src),
      id: crypto.randomUUID(),
      name: `${src.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    await teamStore.save(copy);
    await refreshTeams();
  }

  async function handleDelete(id: string) {
    await teamStore.remove(id);
    deleteThread(id);
    if (currentTeamId === id) {
      setCurrentTeamId(null);
      setSavedHash(null);
    }
    await refreshTeams();
  }

  async function handleRename(id: string, name: string) {
    const existing = await teamStore.get(id);
    if (!existing) return;
    await teamStore.save({ ...existing, name, updatedAt: Date.now() });
    if (currentTeamId === id) setCurrentTeamName(name);
    await refreshTeams();
  }

  function handleExportTeam(t: SavedTeam) {
    setExportPaste(exportTeamPaste(t.team, lists.speciesAbilities));
  }

  // ─── Save (⋯ menu) — uses the inline toolbar name, defaulting to "Untitled Team" ──
  function handleSaveButton() {
    // First save of an untitled team: offer instant, composition-based names before writing.
    if (!currentTeamId && isPlaceholderName(currentTeamName) && team) {
      const suggestions = suggestTeamNames(team);
      setNamePicker({ value: suggestions[0] ?? 'Untitled Team', suggestions, then: 'save' });
      return;
    }
    saveCurrentTeam(currentTeamName.trim() || 'Untitled Team');
  }

  function openNamePicker() {
    if (!team) return;
    const suggestions = suggestTeamNames(team);
    setNamePicker({ value: isPlaceholderName(currentTeamName) ? (suggestions[0] ?? '') : currentTeamName, suggestions, then: currentTeamId ? 'rename' : 'save' });
  }

  function confirmNamePicker() {
    if (!namePicker) return;
    const name = namePicker.value.trim() || 'Untitled Team';
    setNamePicker(null);
    if (namePicker.then === 'save') saveCurrentTeam(name);
    else commitTeamName(name);
  }

  /** Inline toolbar rename: updates the open team and, if it is saved, the library record. */
  function commitTeamName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentTeamName) return;
    setCurrentTeamName(trimmed);
    if (currentTeamId) handleRename(currentTeamId, trimmed);
  }

  // ─── Editor handlers ───────────────────────────────────────────────────────
  async function reeval(updated: TeamMon) {
    if (!updated.benchmarks?.length) return;
    setReevaluating((prev) => new Set([...prev, updated.slot]));
    try {
      const r = await aiFetch('/api/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ species: updated.species, mon: { species: updated.species, ability: updated.ability, item: updated.item, nature: updated.nature, sp: updated.sp }, benchmarks: updated.benchmarks }) });
      if (!r.ok) return;
      const data = await r.json();
      setTeam((prev) => prev?.map((m) => (m && m.slot === updated.slot ? { ...m, benchmarks: data.benchmarks } : m)) ?? prev);
    } catch { /* best-effort */ }
    finally {
      setReevaluating((prev) => { const next = new Set(prev); next.delete(updated.slot); return next; });
    }
  }

  // Edits write through on every keystroke, so benchmark re-evaluation is debounced per slot
  // (latest edit wins) instead of firing a request per change.
  const reevalTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = reevalTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  function handleUpdate(slot: number, updated: TeamMon) {
    setTeam((prev) => prev?.map((m) => (m && m.slot === slot ? updated : m)) ?? prev);
    const pending = reevalTimers.current.get(slot);
    if (pending) clearTimeout(pending);
    reevalTimers.current.set(slot, setTimeout(() => {
      reevalTimers.current.delete(slot);
      reeval(updated);
    }, 600));
  }

  function handleAdd(slotIndex: number, species: string) {
    setTeam((prev) => prev?.map((m, i) => (i === slotIndex ? makeMon(species, i + 1, lists) : m)) ?? prev);
  }

  function handleRemove(slotIndex: number) {
    setTeam((prev) => prev?.map((m, i) => (i === slotIndex ? null : m)) ?? prev);
  }

  function handleReorder(from: number, to: number) {
    if (from === to) return;
    setTeam((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next.map((m, i) => (m ? { ...m, slot: i + 1 } : m));
    });
  }

  async function handleImportSingleSlot(slotIndex: number, paste: string): Promise<TeamMon | string> {
    try {
      const r = await aiFetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paste, regulation: ruleset }) });
      const data = await r.json();
      if (!r.ok) return data.error ?? 'Import failed.';
      const mon = (data.team as TeamMon[])[0];
      if (!mon) return 'No Pokémon found in paste.';
      const placed: TeamMon = { ...mon, slot: slotIndex + 1 };
      setTeam((prev) => prev?.map((m, i) => (i === slotIndex ? placed : m)) ?? prev);
      return placed;
    } catch (e) { return (e as Error).message; }
  }

  // ─── Team helpers shared by the UI and assistant actions ───────────────────
  function applyTeamChanges(slot: number, c: { item?: string; ability?: string; nature?: string; moves?: string[]; sp?: SpSpread }) {
    const current = team?.[slot - 1];
    if (!current) return;
    const nature = c.nature ?? current.nature;
    const sp = c.sp !== undefined ? { ...current.sp, ...c.sp } : current.sp;
    const base = lists.speciesStats[current.species];
    const updated: TeamMon = {
      ...current,
      ...(c.item !== undefined ? { item: c.item } : {}),
      ...(c.ability !== undefined ? { ability: c.ability } : {}),
      nature,
      ...(c.moves !== undefined ? { moves: padMoves(c.moves) } : {}),
      sp,
      computedStats: base ? calcChampionsStats(base, sp, nature) : current.computedStats,
    };
    handleUpdate(slot, updated);
  }

  function applyBuiltTeam(result: { team: TeamSlot[]; summary: string }) {
    const previous = team ?? Array(6).fill(null);
    const filledBefore = previous.filter(Boolean).length;
    setTeam(result.team);
    setIssues([]);
    setBuilderBanner({ summary: result.summary, previous, filled: result.team.filter(Boolean).length - filledBefore });
  }

  // ─── Speed-screen edits (assistant) ────────────────────────────────────────
  function applySpeedUpdate(a: UpdateSpeedTierAction) {
    const filled = (team ?? []).filter((m): m is TeamMon => m !== null);
    const matches = (e: SpeedEntryState, target: string) => {
      const t = target.trim().toLowerCase();
      const slotMatch = t.match(/^slot\s*(\d)$/);
      if (slotMatch) return e.teamSlot === Number(slotMatch[1]);
      return e.species.toLowerCase() === t || (e.teamSlot != null && filled.find((m) => m.slot === e.teamSlot)?.species.toLowerCase() === t);
    };
    setSpeedState((prev) => {
      let entries = a.clear ? [] : [...prev.entries];
      for (const target of a.remove ?? []) entries = entries.filter((e) => !matches(e, target));
      for (const slot of a.addMine ?? []) {
        const mon = filled.find((m) => m.slot === slot);
        if (mon && !entries.some((e) => e.teamSlot === slot)) entries.push(mineEntry(mon));
      }
      for (const opp of a.addOpponents ?? []) {
        if (lists.speciesStats[opp.species]) entries.push(oppEntry(opp.species, opp.nature, opp.speSP));
      }
      for (const p of a.patch ?? []) {
        entries = entries.map((e) => {
          if (!matches(e, p.target)) return e;
          return {
            ...e,
            ...(p.stage !== undefined ? { stage: Math.max(-6, Math.min(6, Math.round(p.stage))) } : {}),
            ...(p.paralyzed !== undefined ? { paralyzed: p.paralyzed } : {}),
            ...(p.scarf !== undefined ? { scarf: p.scarf } : {}),
            ...(p.priority !== undefined ? { priority: Math.round(p.priority) } : {}),
            ...(p.nature !== undefined && e.side === 'opp' ? { nature: p.nature } : {}),
            ...(p.speSP !== undefined && e.side === 'opp' ? { speSP: Math.max(0, Math.min(32, Math.round(p.speSP))) } : {}),
          };
        });
      }
      return { ...prev, ...(a.toggles ?? {}), entries };
    });
  }

  function applyCalcUpdate(a: UpdateCalcAction) {
    setCalcState((prev) => {
      const base = a.swap ? { ...prev, attacker: prev.defender, defender: prev.attacker } : prev;
      const merge = (cur: CalcMonSet, patch?: Partial<CalcMonSet>): CalcMonSet => patch ? {
        ...cur,
        ...patch,
        sp: patch.sp !== undefined ? (patch.species && patch.species !== cur.species ? patch.sp : { ...cur.sp, ...patch.sp }) : cur.sp,
        moves: patch.moves !== undefined ? padMoves(patch.moves) : cur.moves,
      } : cur;
      return {
        attacker: merge(base.attacker, a.attacker),
        defender: merge(base.defender, a.defender),
        field: { ...base.field, ...(a.field ?? {}) },
      };
    });
    if (a.run) setCalcRunToken((t) => t + 1);
  }

  function handleChatAction(action: ChatAction) {
    switch (action.type) {
      case 'navigateTo':
        setView(action.tab);
        break;
      case 'setupDamageCalc':
        setCalcState((prev) => ({ ...prev, attacker: padSet(action.attacker), defender: padSet(action.defender) }));
        setView('calc');
        break;
      case 'updateCalc':
        applyCalcUpdate(action);
        setView('calc');
        break;
      case 'setupSpeedTier': {
        const filled = (team ?? []).filter((m): m is TeamMon => m !== null);
        const entries: SpeedEntryState[] = [];
        for (const slot of action.mine ?? []) {
          const mon = filled.find((m) => m.slot === slot);
          if (mon) entries.push(mineEntry(mon));
        }
        for (const opp of action.opponents ?? []) {
          if (lists.speciesStats[opp.species]) entries.push(oppEntry(opp.species, opp.nature, opp.speSP));
        }
        setSpeedState((prev) => ({ ...prev, entries }));
        setView('speed');
        break;
      }
      case 'updateSpeedTier':
        applySpeedUpdate(action);
        setView('speed');
        break;
      case 'applyTeamEdit':
      case 'proposeTeamEdit':
        applyTeamChanges(action.slot, action.changes);
        break;
      case 'setTeamSlot':
      case 'proposeSubstitution': {
        const newMon = monFromSet(action.slot, action, lists);
        setTeam((prev) => (prev ?? Array(6).fill(null)).map((m, i) => (i === action.slot - 1 ? newMon : m)));
        setView('team');
        break;
      }
      case 'removeTeamSlot':
        handleRemove(action.slot - 1);
        break;
      case 'reorderTeam':
        handleReorder(action.from - 1, action.to - 1);
        break;
      case 'renameTeam':
        setCurrentTeamName(action.name);
        if (currentTeamId) handleRename(currentTeamId, action.name);
        break;
      case 'proposeBenchmark': {
        const current = team?.[action.slot - 1];
        if (!current) return;
        aiFetch('/api/benchmark/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: action.description, species: current.species, mon: { species: current.species, ability: current.ability, item: current.item, nature: current.nature, sp: current.sp, moves: current.moves, computedStats: current.computedStats } }) })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { benchmark: Benchmark } | null) => {
            if (!data) return;
            setTeam((prev) => prev?.map((m) => m && m.slot === action.slot ? { ...m, benchmarks: [...m.benchmarks, data.benchmark] } : m) ?? prev);
          })
          .catch(() => {});
        break;
      }
    }
  }

  // ─── Chat: one conversation per team ──────────────────────────────────────
  const chatTeam = team ? team.filter((m): m is TeamMon => m !== null) : null;
  const chat = useChampionsChat({
    team: chatTeam,
    getContext: (): ScreenContext => ({ view, teamName: currentTeamName, calc: calcState, speed: speedState }),
    onAction: handleChatAction,
    regulation: ruleset,
    threadKey: currentTeamId ?? DRAFT_THREAD,
  });

  // ─── Team vs. active ruleset ───────────────────────────────────────────────
  // Lists are per ruleset, so anything on the team that the current lists don't know is not legal
  // here (e.g. a Reg M-C addition while Reg M-B is selected). Computed live, never stored.
  const rulesetProblems: string[] = [];
  for (const m of team ?? []) {
    if (!m) continue;
    if (!lists.speciesStats[m.species]) rulesetProblems.push(`${rules.short} · ${m.species} is not usable`);
    if (m.item && !lists.items.includes(m.item)) rulesetProblems.push(`${rules.short} · ${m.species}: ${m.item} is not legal`);
    for (const mv of m.moves) if (mv && !lists.moveInfo[mv]) rulesetProblems.push(`${rules.short} · ${m.species}: ${mv} is not available`);
    const stone = lists.stoneOfMega[m.species];
    if (stone && m.item !== stone) rulesetProblems.push(`${m.species} needs ${stone} to Mega Evolve — it is holding ${m.item || 'nothing'}`);
  }
  // Half-picked natures (a raised stat with nothing lowered, or the reverse) block saving,
  // exporting, and the calc screens until the other half is chosen.
  const natureProblems = (team ?? []).flatMap((m) => {
    const issue = m ? natureIssue(m.nature) : null;
    return issue ? [`${m!.species}: nature incomplete — ${issue}`] : [];
  });
  /** Ruleset problems first (prefixed with the regulation), then natures, then the importer's legality notes. */
  const allIssues: string[] = [...rulesetProblems, ...natureProblems, ...issues.map((i) => i.message)];

  // The refusal notice clears itself once the nature is completed.
  if (saveError?.startsWith('Finish the nature first') && !natureProblems.length) setSaveError(null);

  /** Refuse an action while a nature is half-picked; the reason lands in the red notice row. */
  function requireCompleteNatures(what: string): boolean {
    if (!natureProblems.length) return true;
    setSaveError(`Finish the nature first (${natureProblems.join('; ')}) before you ${what}.`);
    return false;
  }

  const filledCount = team ? team.filter((m): m is TeamMon => m !== null).length : 0;

  // Export modal — reachable from both the library cards and the editor toolbar.
  const exportModal = exportPaste !== null && (
    <ExportModal
      paste={exportPaste}
      title={currentTeamName}
      copied={copiedExport}
      onCopy={() => {
        navigator.clipboard.writeText(exportPaste).then(() => {
          setCopiedExport(true);
          setTimeout(() => setCopiedExport(false), 1800);
        });
      }}
      onClose={() => { setExportPaste(null); setCopiedExport(false); }}
    />
  );

  // Import modal — opened from the library header or the editor's ⋯ menu.
  const importModal = showImport && (
    <ImportModal
      paste={paste}
      onPasteChange={setPaste}
      importing={importing}
      error={error}
      replace={importTarget === 'replace'}
      onImport={() => doImport()}
      onSample={() => setPaste(SAMPLE_PASTE)}
      onClose={() => { if (!importing) setShowImport(false); }}
    />
  );

  // ─── Library mode ──────────────────────────────────────────────────────────
  if (mode === 'library') {
    return (
      <>
        <TeamLibrary
          teams={savedTeams}
          pendingBlurbs={pendingBlurbs}
          onOpen={openTeam}
          onNew={startNew}
          onImport={openImportModal}
          onExport={handleExportTeam}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
          onRename={handleRename}
          aside={
            movedTeams > 0 ? (
              <div style={{ borderRadius: 10, border: '1px solid rgba(52,211,153,0.3)', background: 'rgba(16,185,129,0.07)', padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#a7f3d0' }}>
                <span style={{ flex: 1 }}>Moved {movedTeams} team{movedTeams > 1 ? 's' : ''} saved in this browser into your account.</span>
                <button onClick={() => setMovedTeams(0)} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
              </div>
            ) : null
          }
        />
        {exportModal}
        {importModal}
      </>
    );
  }

  // ─── Editor mode ───────────────────────────────────────────────────────────
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : `1fr ${chatOpen ? '320px' : '42px'}`,
          transition: 'grid-template-columns 0.3s cubic-bezier(0.4,0,0.2,1)',
          height: '100%',
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        {/* Left: workspace */}
        <div
          className="m-tight"
          style={{
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 11,
            minWidth: 0,
          }}
        >
          {/* Toolbar: ← Library | team name | Team · Damage Calc · Speed Tiers | ⋯ */}
          <div className="m-wrap" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              onClick={goToLibrary}
              style={{
                padding: '6px 12px',
                borderRadius: 9,
                border: '1px solid rgba(99,102,241,0.14)',
                background: 'transparent',
                color: '#50507a',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              ← Library
            </button>
            <div style={{ width: 1, height: 18, background: 'rgba(99,102,241,0.18)', flexShrink: 0 }} />
            <InlineTeamName value={currentTeamName} onCommit={commitTeamName} />
            {team && (
              <button
                onClick={openNamePicker}
                title="Suggest a name from the team"
                aria-label="Suggest a team name"
                style={{ background: 'none', border: 'none', color: '#8b8bf0', fontSize: 13, cursor: 'pointer', padding: '0 2px', fontWeight: 900, lineHeight: 1 }}
              >
                ✦
              </button>
            )}
            <div style={{ flex: 1 }} />
            <div className="editor-tabs" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <TabBtn active={view === 'team'} onClick={() => setView('team')}>
              Team
            </TabBtn>
            <TabBtn active={view === 'calc'} onClick={() => { if (requireCompleteNatures('open the Damage Calc')) setView('calc'); }}>
              Damage Calc
            </TabBtn>
            <TabBtn active={view === 'speed'} onClick={() => { if (requireCompleteNatures('open Speed Tiers')) setView('speed'); }}>
              Speed Tiers
            </TabBtn>
            <div style={{ width: 1, height: 18, background: 'rgba(99,102,241,0.18)', flexShrink: 0 }} />
            <ToolbarMenu
              open={menuOpen}
              onToggle={() => setMenuOpen((o) => !o)}
              onClose={() => setMenuOpen(false)}
              items={[
                { label: 'Save', hint: currentTeamId ? undefined : 'new', onClick: () => { if (requireCompleteNatures('save')) handleSaveButton(); }, disabled: !team },
                { label: 'Export', onClick: () => { if (team && requireCompleteNatures('export')) setExportPaste(exportTeamPaste(team, lists.speciesAbilities)); }, disabled: !team },
                { label: 'Import (replace team)', onClick: openImportModal },
              ]}
            />
            </div>
          </div>

          {/* Everything the current ruleset or the importer flagged, in one row */}
          {saveError && (
            <div style={{ borderRadius: 9, border: '1px solid rgba(248,113,113,0.35)', background: 'rgba(239,68,68,0.09)', padding: '8px 12px', fontSize: 11, color: '#fca5a5', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 1 }}>{saveError}</span>
              <button onClick={() => setSaveError(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
          )}

          {allIssues.length > 0 && (
            <div
              style={{
                borderRadius: 9,
                border: '1px solid rgba(251,191,36,0.25)',
                background: 'rgba(180,130,20,0.08)',
                padding: '8px 12px',
                fontSize: 11,
                color: '#fbbf24',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
                <strong style={{ fontWeight: 800 }}>{allIssues.length} issue{allIssues.length > 1 ? 's' : ''}:</strong>{' '}
                {issuesExpanded ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                    {allIssues.map((msg, i) => <span key={i}>{msg}</span>)}
                  </div>
                ) : (
                  <>{allIssues.slice(0, 3).join(' · ')}{allIssues.length > 3 && ' …'}</>
                )}
              </div>
              {allIssues.length > 3 && (
                <button
                  onClick={() => setIssuesExpanded((e) => !e)}
                  style={{ background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: 0, flexShrink: 0, whiteSpace: 'nowrap' }}
                >
                  {issuesExpanded ? 'Show less' : `Show all ${allIssues.length}`}
                </button>
              )}
            </div>
          )}

          {/* Content */}
          {view === 'team' ? (
            team ? (
              <div style={{ animation: 'fadeUp 0.18s ease', display: 'flex', flexDirection: 'column', gap: 11 }}>
                {builderBanner && (
                  <div style={{ borderRadius: 10, border: '1px solid rgba(167,139,250,0.35)', background: 'rgba(124,58,237,0.08)', padding: '9px 12px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ color: '#a78bfa', fontWeight: 900, fontSize: 13 }}>✦</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#c4b5fd', marginBottom: 2 }}>
                        Filled {builderBanner.filled} slot{builderBanner.filled === 1 ? '' : 's'} — every set is editable below.
                      </div>
                      {builderBanner.summary && <div style={{ fontSize: 11, color: '#9a9ac8', lineHeight: 1.5 }}>{builderBanner.summary}</div>}
                    </div>
                    <button onClick={() => { setTeam(builderBanner.previous); setBuilderBanner(null); }} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(167,139,250,0.35)', background: 'transparent', color: '#c4b5fd', fontSize: 11, fontWeight: 800, cursor: 'pointer', flexShrink: 0 }}>Undo</button>
                    <button onClick={() => setBuilderBanner(null)} style={{ background: 'none', border: 'none', color: '#50507a', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
                  </div>
                )}
                <TeamBuilderPanel key={`${currentTeamId ?? 'new'}-${filledCount}`} team={team} onBuilt={applyBuiltTeam} />
                <TeamView
                  team={team}
                  lists={lists}
                  onUpdate={handleUpdate}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onReorder={handleReorder}
                  onImportSlot={handleImportSingleSlot}
                  reevaluating={reevaluating}
                />
              </div>
            ) : null
          ) : view === 'calc' ? (
            <div style={{ animation: 'fadeUp 0.18s ease' }}>
              <DamageCalcView
                lists={lists}
                team={chatTeam}
                state={calcState}
                onChange={(patch) => setCalcState((prev) => ({ ...prev, ...patch }))}
                runToken={calcRunToken}
              />
            </div>
          ) : (
            <div style={{ animation: 'fadeUp 0.18s ease' }}>
              <SpeedTierView team={chatTeam} lists={lists} state={speedState} onChange={setSpeedState} />
            </div>
          )}
        </div>

        {/* Right: chat panel (a column beside the editor; on phones a full-screen sheet below) */}
        {!isMobile && (
          <ChatPanel
            team={chatTeam}
            teamName={currentTeamName}
            view={view}
            onAction={handleChatAction}
            isOpen={chatOpen}
            onToggle={() => setChatOpen(!chatOpen)}
            messages={chat.messages}
            setMessages={chat.setMessages}
            loading={chat.loading}
            error={chat.error}
            onSend={chat.send}
          />
        )}
      </div>

      {isMobile && (chatOpen ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: '#0b0b1a', display: 'flex', flexDirection: 'column' }}>
          <ChatPanel
            team={chatTeam}
            teamName={currentTeamName}
            view={view}
            onAction={handleChatAction}
            isOpen
            onToggle={() => setChatOpen(false)}
            messages={chat.messages}
            setMessages={chat.setMessages}
            loading={chat.loading}
            error={chat.error}
            onSend={chat.send}
          />
        </div>
      ) : (
        <button
          onClick={() => setChatOpen(true)}
          aria-label="Open the AI assistant"
          style={{ position: 'fixed', right: 14, bottom: 'calc(14px + env(safe-area-inset-bottom))', zIndex: 800, padding: '10px 16px', borderRadius: 999, background: '#6366f1', color: 'white', border: 'none', fontSize: 13, fontWeight: 900, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', cursor: 'pointer' }}
        >
          ✦ Assistant{chat.loading ? '…' : ''}
        </button>
      ))}

      {exportModal}
      {importModal}

      {/* ── Name picker (first save / ✦ next to the name) ───────────────────── */}
      {namePicker && (
        <ModalOverlay onClose={() => setNamePicker(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 800, color: '#eaeaf8', margin: 0 }}>Name this team</p>
              <p style={{ fontSize: 11, color: '#6a6a9a', margin: '3px 0 0' }}>Suggested from the team&apos;s mode, Mega, and core. Edit freely.</p>
            </div>
            <input
              value={namePicker.value}
              onChange={(e) => setNamePicker({ ...namePicker, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmNamePicker(); if (e.key === 'Escape') setNamePicker(null); }}
              onFocus={(e) => e.currentTarget.select()}
              autoFocus
              placeholder="Team name"
              aria-label="Team name"
              style={{ background: 'rgba(5,5,15,0.9)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 8, padding: '8px 11px', color: '#eaeaf8', fontSize: 14, fontWeight: 800, outline: 'none', colorScheme: 'dark' } as React.CSSProperties}
            />
            <NameChips suggestions={namePicker.suggestions} current={namePicker.value} onPick={(v) => setNamePicker({ ...namePicker, value: v })} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmNamePicker} style={{ padding: '6px 18px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
                {namePicker.then === 'save' ? 'Save' : 'Rename'}
              </button>
              {namePicker.then === 'save' && (
                <button onClick={() => { setNamePicker(null); saveCurrentTeam('Untitled Team'); }} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  Save as Untitled
                </button>
              )}
              <button onClick={() => setNamePicker(null)} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Save-prompt modal (unsaved changes guard) ───────────────────────── */}
      {showSavePrompt && (
        <ModalOverlay onClose={() => setShowSavePrompt(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontSize: 14, color: '#c0c0e0', margin: 0 }}>
              Save changes to <strong style={{ color: '#eaeaf8' }}>{currentTeamName}</strong>?
            </p>
            <input
              value={savePromptName}
              onChange={(e) => setSavePromptName(e.target.value)}
              placeholder="Team name"
              style={{
                background: 'rgba(5,5,15,0.9)',
                border: '1px solid rgba(99,102,241,0.3)',
                borderRadius: 8,
                padding: '7px 10px',
                color: '#eaeaf8',
                fontSize: 13,
                outline: 'none',
                colorScheme: 'dark',
              } as React.CSSProperties}
            />
            {team && <NameChips suggestions={suggestTeamNames(team)} current={savePromptName} onPick={setSavePromptName} />}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => {
                  setShowSavePrompt(false);
                  await saveCurrentTeam(savePromptName || currentTeamName);
                  if (savePromptTarget === 'library') setMode('library');
                }}
                style={{ padding: '6px 18px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setShowSavePrompt(false);
                  if (savePromptTarget === 'library') setMode('library');
                }}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
              >
                Discard
              </button>
              <button
                onClick={() => setShowSavePrompt(false)}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

    </>
  );
}

// ─── Shared UI primitives ──────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 15px',
        borderRadius: 9,
        border: `1px solid ${active ? 'rgba(99,102,241,0.45)' : 'rgba(99,102,241,0.14)'}`,
        background: active ? 'rgba(99,102,241,0.18)' : 'transparent',
        color: active ? '#e4e4f8' : '#50507a',
        fontSize: 13,
        fontWeight: 800,
        cursor: 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

/** Click-to-edit team name in the editor toolbar. Enter or blur commits; Escape reverts. */
/** One-click name suggestions (chips); the current value is highlighted. */
function NameChips({ suggestions, current, onPick }: { suggestions: string[]; current: string; onPick: (name: string) => void }) {
  if (!suggestions.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {suggestions.map((s) => {
        const active = s === current;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            style={{ padding: '4px 10px', borderRadius: 999, border: `1px solid ${active ? '#8b8bf0' : 'rgba(99,102,241,0.28)'}`, background: active ? 'rgba(99,102,241,0.22)' : 'rgba(99,102,241,0.07)', color: active ? '#e4e4f8' : '#a0a0d8', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}
          >
            ✦ {s}
          </button>
        );
      })}
    </div>
  );
}

function InlineTeamName({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEditing() { setDraft(value); setEditing(true); }
  function commit() { setEditing(false); onCommit(draft); }

  if (editing) {
    return (
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        autoFocus
        aria-label="Team name"
        style={{
          minWidth: 120,
          maxWidth: 260,
          background: 'rgba(5,5,15,0.9)',
          border: '1px solid rgba(99,102,241,0.4)',
          borderRadius: 7,
          padding: '4px 9px',
          color: '#eaeaf8',
          fontSize: 13,
          fontWeight: 800,
          outline: 'none',
          colorScheme: 'dark',
        } as React.CSSProperties}
      />
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={startEditing}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEditing(); } }}
      title="Click to rename"
      style={{
        fontSize: 13,
        fontWeight: 800,
        color: '#eaeaf8',
        cursor: 'text',
        padding: '4px 9px',
        borderRadius: 7,
        border: '1px solid transparent',
        maxWidth: 260,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}
    >
      {value}
    </span>
  );
}

/** The toolbar's ⋯ menu: Save / Export / Import. Closes on outside click or Escape. */
function ToolbarMenu({ open, onToggle, onClose, items }: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  items: { label: string; hint?: string; onClick: () => void; disabled?: boolean }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={onToggle}
        title="Save, export, import"
        aria-label="Team actions"
        aria-expanded={open}
        style={{
          padding: '5px 11px',
          borderRadius: 8,
          border: `1px solid ${open ? 'rgba(99,102,241,0.45)' : 'rgba(99,102,241,0.22)'}`,
          background: open ? 'rgba(99,102,241,0.18)' : 'rgba(99,102,241,0.07)',
          color: open ? '#e4e4f8' : '#7070a0',
          fontSize: 14,
          fontWeight: 900,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            zIndex: 60,
            minWidth: 190,
            borderRadius: 9,
            border: '1px solid rgba(99,102,241,0.28)',
            background: 'rgba(10,10,24,0.98)',
            padding: 4,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => { if (it.disabled) return; onClose(); it.onClick(); }}
              disabled={it.disabled}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: it.disabled ? '#40406a' : '#c0c0e4',
                fontSize: 12,
                fontWeight: 700,
                cursor: it.disabled ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'rgba(99,102,241,0.16)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span>{it.label}</span>
              {it.hint && <span style={{ fontSize: 9, color: '#50507a', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dark modal overlay — matches the indigo palette used throughout the app. */
function ModalOverlay({ children, onClose, width = 420 }: { children: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4,4,14,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          borderRadius: 14,
          border: '1px solid rgba(99,102,241,0.28)',
          background: 'rgba(11,11,28,0.98)',
          padding: '22px 24px',
          width,
          maxWidth: '90vw',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Full-team Showdown paste import. */
function ImportModal({ paste, onPasteChange, importing, error, replace, onImport, onSample, onClose }: {
  paste: string;
  onPasteChange: (v: string) => void;
  importing: boolean;
  error: string | null;
  replace: boolean;
  onImport: () => void;
  onSample: () => void;
  onClose: () => void;
}) {
  return (
    <ModalOverlay onClose={onClose} width={540}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#eaeaf8', margin: 0 }}>Import Team Paste</p>
          {replace && <span style={{ fontSize: 11, color: '#7070a0' }}>replaces every slot of the open team</span>}
        </div>
        <textarea
          value={paste}
          onChange={(e) => onPasteChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onImport(); }}
          placeholder="Paste a Showdown-style team…"
          rows={12}
          autoFocus
          style={{
            width: '100%',
            borderRadius: 8,
            border: '1px solid rgba(99,102,241,0.2)',
            background: 'rgba(5,5,15,0.9)',
            padding: '10px 12px',
            fontFamily: "'Courier New', monospace",
            fontSize: 12,
            color: '#b0b0d0',
            outline: 'none',
            resize: 'vertical',
            display: 'block',
            colorScheme: 'dark',
          } as React.CSSProperties}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={onImport}
            disabled={importing || !paste.trim()}
            style={{
              padding: '6px 20px',
              borderRadius: 8,
              background: '#6366f1',
              color: 'white',
              border: 'none',
              fontSize: 13,
              fontWeight: 800,
              cursor: importing || !paste.trim() ? 'not-allowed' : 'pointer',
              opacity: importing || !paste.trim() ? 0.6 : 1,
            }}
          >
            {importing ? 'Inferring roles…' : 'Import'}
          </button>
          <button
            onClick={onClose}
            disabled={importing}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.22)', background: 'transparent', color: '#7070a0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={onSample}
            style={{ fontSize: 12, color: '#50507a', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
          >
            Use sample team
          </button>
          {error && <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span>}
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Shared export modal — dark textarea + copy button. */
function ExportModal({ paste, title, copied, onCopy, onClose }: { paste: string; title: string; copied: boolean; onCopy: () => void; onClose: () => void }) {
  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#eaeaf8', margin: 0 }}>Export Team Paste</p>
        <textarea
          readOnly
          value={paste}
          rows={12}
          style={{
            width: '100%',
            borderRadius: 8,
            border: '1px solid rgba(99,102,241,0.2)',
            background: 'rgba(5,5,15,0.9)',
            padding: '10px 12px',
            fontFamily: "'Courier New', monospace",
            fontSize: 12,
            color: '#b0b0d0',
            outline: 'none',
            resize: 'vertical',
            display: 'block',
            colorScheme: 'dark',
          } as React.CSSProperties}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onCopy}
            style={{
              padding: '6px 18px',
              borderRadius: 8,
              background: copied ? '#22543d' : '#6366f1',
              color: copied ? '#6ee7b7' : 'white',
              border: 'none',
              fontSize: 13,
              fontWeight: 800,
              cursor: 'pointer',
              transition: 'background 0.2s, color 0.2s',
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid rgba(99,102,241,0.22)',
              background: 'transparent',
              color: '#7070a0',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
        <ShareButtons paste={paste} title={title} />
      </div>
    </ModalOverlay>
  );
}
