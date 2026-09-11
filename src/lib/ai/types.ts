import type { SpSpread } from '@/lib/calc/sp';

export interface CalcMonSet {
  species: string;
  ability: string;
  item: string;
  nature: string;
  sp: SpSpread;
  moves: string[];
}

// ─── Screen state shared between the UI and the assistant ─────────────────────
//
// The editor screens (Damage Calc, Speed Tiers) keep their settings in Workspace so the assistant
// can both read them (they are serialized into the system prompt) and change them (via the
// update* actions below). Results/derived values are not part of this state.

export interface CalcFieldState {
  gameType: 'Doubles' | 'Singles';
  weather: string;
  terrain: string;
  isCrit: boolean;
}

export interface CalcScreenState {
  attacker: CalcMonSet;
  defender: CalcMonSet;
  field: CalcFieldState;
}

export interface SpeedEntryState {
  id: string;
  species: string;
  side: 'mine' | 'opp';
  /** Set for team members — their Speed comes from the team set, not nature/speSP below. */
  teamSlot?: number;
  nature: string;
  speSP: number;
  stage: number;
  paralyzed: boolean;
  scarf: boolean;
  priority: number;
}

export interface SpeedScreenState {
  tailwindMine: boolean;
  tailwindOpp: boolean;
  trickRoom: boolean;
  showPriority: boolean;
  entries: SpeedEntryState[];
}

export type WorkspaceView = 'team' | 'calc' | 'speed';

/** Everything the assistant needs to know about what is on screen right now. */
export interface ScreenContext {
  view: WorkspaceView;
  teamName: string;
  calc: CalcScreenState;
  speed: SpeedScreenState;
}

// ─── Proposal actions (user accepts/rejects a card) ────────────────────────────

export interface ProposeTeamEditAction {
  type: 'proposeTeamEdit';
  slot: number;
  label: string;
  changes: {
    item?: string;
    ability?: string;
    nature?: string;
    moves?: string[];
    sp?: SpSpread;
  };
  reason: string;
}

export interface ProposeBenchmarkAction {
  type: 'proposeBenchmark';
  slot: number;
  description: string;
  reason: string;
}

export interface ProposeSubstitutionAction {
  type: 'proposeSubstitution';
  slot: number;
  species: string;
  ability: string;
  item: string;
  nature: string;
  moves: string[];
  sp: SpSpread;
  reason: string;
}

// ─── Direct actions (applied immediately — the user asked for the change) ──────

export interface SpeedOpponent {
  species: string;
  nature?: string;
  speSP?: number;
}

export interface SetupSpeedTierAction {
  type: 'setupSpeedTier';
  /** Team slot numbers (1–6) to show on the mine side. */
  mine?: number[];
  /** Opponent species to add, with optional nature/speSP overrides. */
  opponents?: SpeedOpponent[];
}

export interface UpdateCalcAction {
  type: 'updateCalc';
  /** Partial set changes; `moves` replaces the whole list, `sp` merges onto the current spread. */
  attacker?: Partial<CalcMonSet>;
  defender?: Partial<CalcMonSet>;
  field?: Partial<CalcFieldState>;
  /** Swap attacker and defender (applied before the partial changes). */
  swap?: boolean;
  /** Run "Calc All" once the changes are applied. */
  run?: boolean;
}

export interface SpeedEntryPatch {
  /** Species name, or "slot N" for one of the user's team members. Matches every entry with that identity. */
  target: string;
  stage?: number;
  paralyzed?: boolean;
  scarf?: boolean;
  priority?: number;
  nature?: string;
  speSP?: number;
}

export interface UpdateSpeedTierAction {
  type: 'updateSpeedTier';
  toggles?: Partial<Pick<SpeedScreenState, 'tailwindMine' | 'tailwindOpp' | 'trickRoom' | 'showPriority'>>;
  /** Remove every entry first. */
  clear?: boolean;
  addMine?: number[];
  addOpponents?: SpeedOpponent[];
  /** Entries to remove — species names or "slot N". */
  remove?: string[];
  patch?: SpeedEntryPatch[];
}

export interface ApplyTeamEditAction {
  type: 'applyTeamEdit';
  slot: number;
  changes: ProposeTeamEditAction['changes'];
}

export interface SetTeamSlotAction {
  type: 'setTeamSlot';
  slot: number;
  species: string;
  ability: string;
  item: string;
  nature: string;
  moves: string[];
  sp: SpSpread;
}

export interface RemoveTeamSlotAction {
  type: 'removeTeamSlot';
  slot: number;
}

export interface ReorderTeamAction {
  type: 'reorderTeam';
  from: number;
  to: number;
}

export interface RenameTeamAction {
  type: 'renameTeam';
  name: string;
}

export type ChatAction =
  | { type: 'navigateTo'; tab: WorkspaceView }
  | { type: 'setupDamageCalc'; attacker: CalcMonSet; defender: CalcMonSet }
  | SetupSpeedTierAction
  | UpdateCalcAction
  | UpdateSpeedTierAction
  | ApplyTeamEditAction
  | SetTeamSlotAction
  | RemoveTeamSlotAction
  | ReorderTeamAction
  | RenameTeamAction
  | ProposeTeamEditAction
  | ProposeBenchmarkAction
  | ProposeSubstitutionAction;

// ─── Compare sets (dynamic opponents for the calc + speed screens) ─────────────

export interface CompareOpponent extends CalcMonSet {
  /** One short line on why this Pokémon matters for the focus set. */
  reason: string;
}

export interface CompareSetResponse {
  opponents: CompareOpponent[];
  /** 'ai' when Gemini chose the list; 'rankings' when it fell back to the top of the usage table. */
  source: 'ai' | 'rankings';
}
