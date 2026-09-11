# VGC Champions Tool — Full Spec

## Overview

A personal AI-powered competitive Pokémon tool for Champions Series play. Built for one user. The tool combines a deterministic damage calculation engine with an AI layer that interprets natural language queries, proposes EV changes, and reasons about team-level synergy. Every numeric output is computed by code — Claude never estimates a number.

Ground truth for all mechanics lives in two companion documents:
- `ground-truth-vgc-mechanics.md` — universal VGC doubles rules (Layer 1)
- `ground-truth-reg-mb.md` — Regulation M-B specific rules and metagame (Layer 3)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React (Next.js App Router) |
| Backend | Next.js API routes (serverless) |
| Database | Firebase Firestore |
| Deployment | Vercel |
| Auth | Firebase Auth (Google OAuth) |
| Calc engine | `@smogon/damage-calc` + `@pkmn/data` |
| AI layer | Claude API (claude-sonnet-4-6) |

---

## Regulations at Launch

**Champions Series Regulation M-B only.**

```
id: reg-m-b
gen: 9
team_size: 6 (bring 4)
restricted_slots: 2
mechanic_tera: false
mechanic_megas: true
mechanic_zmoves: false
mechanic_dynamax: false
banned_items: [to be confirmed from official Play Pokemon doc]
data_version: pinned @pkmn/data version at reg launch
```

No Terastallization. Reject any query involving Tera types before running any calc.

Mega Evolution is enabled. Mega stats are stored in a custom overlay collection in Firestore for any Mega not natively in Gen 9 @pkmn/data.

---

## Architecture: Three Layer Model

Every Claude query is assembled from three layers of context. Layer 1 is a static constant baked in at build time. Layer 2 is loaded from Firestore at session start. Layer 3 is injected per session based on the active regulation and loaded team.

```
Layer 1: Immutable Battle Engine (ground-truth-vgc-mechanics.md)
         type chart, damage formula, stat calc, priority brackets, core mechanics
                    ↓
Layer 2: Gen 9 Data Snapshot
         species, moves, abilities, items — pinned @pkmn/data version
                    ↓
Layer 3: Regulation + Team Context (ground-truth-reg-mb.md)
         legal dex, banned items, mechanic toggles, PP values,
         cached usage snapshots, loaded team + inferred benchmarks
```

### Layer 1 — Immutable (never fetched, never changes)

Stored as a TypeScript constant and injected into every Claude system prompt. Full content is defined in `ground-truth-vgc-mechanics.md`. Summary of what is included:

- Full 18x18 type effectiveness matrix
- Gen 9 damage formula with all modifiers
- Stat calculation formula (HP and non-HP, Level 50)
- Priority bracket table with Champions era values
- Doubles-specific rules: spread move 75% penalty, targeting vs. hitting distinction, lone survivor exception
- Screen damage reduction: 33% in doubles (not 50%)
- Critical hit mechanics: 1.5x, ignores negative attacker stages and positive defender stages
- Speed tie resolution: random 50/50 — Claude must always flag these, never assume
- Dynamic Speed: speed order recalculated mid-turn after any modification
- Action sequence: switch → abilities → moves
- Tailwind: doubles Speed for 4 turns
- Trick Room: reverses speed order for 5 turns, -7 priority
- Burn: halves physical damage
- Intimidate: lowers adjacent opponents' Attack one stage on switch-in
- Redirection: Follow Me and Rage Powder (+2) force single-target moves to the user
- Type redirection: Lightningrod (Electric), Storm Drain (Water)
- Status caps: Paralysis 12.5% full proc, Sleep 1-2 turns (33% wake turn 2), Freeze max 3 turns (25% thaw/turn)
- Fixed PP table: 5→8, 10→12, 15→24, >15→20
- Secondary effects after user fainting: Knock Off, Rapid Spin, Mortal Spin, Ceaseless Edge all trigger
- Screens in doubles: 33% reduction (not 50%); Light Clay extends to 8 turns
- Fake Out: cannot be selected after the user's first turn on the field
- Sucker Punch: fails if target uses non-damaging move or moves first in bracket
- Terrain effects table (Electric, Grassy, Psychic, Misty)
- Weather effects table (Sun, Rain, Sand, Snow)

**Claude instruction baked into Layer 1:**
> Never estimate or approximate any numerical output. Always call the provided calc functions. Flag speed ties explicitly. Validate mon/move/item legality against the active regulation before every calc. No Tera in Reg M-B — reject before running.

### Layer 2 — Gen 9 Data Snapshot (loaded at session start)

Sourced from `@pkmn/data`, pinned to a specific version per regulation. Stored in Firestore and never auto-updated mid-regulation. Accessed via tool calls.

### Layer 3 — Regulation + Team Context (injected per session)

Built dynamically from Firestore at session start. Full content is defined in `ground-truth-reg-mb.md`. Includes:

- Active regulation config (Reg M-B values)
- Legal dex + banned items
- Mechanic toggles (Mega: on, Tera: off, Z: off, Dynamax: off)
- Reg M-B specific PP values (including 8 PP cap on Protect variants and Nihil Light)
- Reg M-B specific move data (BP changes, accuracy changes, secondary effect rates)
- Slicing mechanic expansion (Dragon Claw, Shadow Claw, Night Slash, Dire Claw)
- Ability modifications (Unseen Fist 25%, Healer 50%, Unnerve bug)
- Status condition nerfs (Paralysis 12.5%, Sleep 1-2 turns, Freeze max 3 turns)
- Dominant Mega profiles: Mega Dragonite, Mega Glimmora, Mega Aerodactyl, Archaludon
- Fake Out top users and combinations
- Latest cached usage snapshot (Pikalytics)
- Loaded team: all 6 mons with sets, computed stats, roles, and benchmarks
- Active chat history for the current team session

---

## Firestore Data Model

Firestore is NoSQL. Data is organized as collections of documents. Related data is denormalized — documents embed what they need rather than joining across collections.

### Collections

```
/regulations/{regulationId}
  id: string
  name: string
  gen: number
  restrictedSlots: number
  mechanicTera: boolean
  mechanicMegas: boolean
  mechanicZmoves: boolean
  mechanicDynamax: boolean
  bannedItems: string[]
  dataVersion: string              // pinned @pkmn/data version
  notes: string

/regulations/{regulationId}/legalDex/{speciesId}
  speciesId: string
  isRestricted: boolean

/species/{speciesId}
  id: string
  gen: number
  name: string
  type1: string
  type2: string | null
  hp: number
  atk: number
  def: number
  spa: number
  spd: number
  spe: number
  weightKg: number
  abilities: { 0: string, 1?: string, H?: string }
  dataVersion: string

/species/{speciesId}/megaOverlay/{megaId}
  id: string                       // e.g. 'charizard-mega-x'
  baseSpeciesId: string
  regulationId: string             // which reg this mega is legal in
  type1: string
  type2: string | null
  hp: number
  atk: number
  def: number
  spa: number
  spd: number
  spe: number
  ability: string
  notes: string                    // source of stat data

/moves/{moveId}
  id: string
  gen: number
  name: string
  type: string
  category: string                 // 'Physical' | 'Special' | 'Status'
  basePower: number
  accuracy: number
  priority: number
  target: string                   // 'normal' | 'allAdjacentFoes' | 'self' | ...
  flags: object                    // { contact, protect, sound, slicing, ... }
  selfBoost: object | null         // e.g. { def: -1, spd: -1 } for Close Combat
  dataVersion: string

/abilities/{abilityId}
  id: string
  gen: number
  name: string
  desc: string
  shortDesc: string
  dataVersion: string

/items/{itemId}
  id: string
  gen: number
  name: string
  desc: string
  dataVersion: string

/usageSnapshots/{snapshotId}
  regulationId: string
  source: string                   // 'pikalytics' | 'limitless' | 'smogon' | 'home'
  snapshotDate: timestamp
  speciesId: string
  usagePct: number
  commonMoves: Array<{ move: string, usage: number }>
  commonItems: Array<{ item: string, usage: number }>
  commonAbilities: Array<{ ability: string, usage: number }>
  commonSpreads: Array<{
    nature: string,
    evs: { hp, atk, def, spa, spd, spe },
    usage: number,
    computedStats: { hp, atk, def, spa, spd, spe }  // pre-computed final stats
  }>

/tournamentSets/{setId}
  regulationId: string
  eventName: string
  eventDate: timestamp
  playerName: string
  placement: number
  team: object                     // full structured team

/users/{userId}
  email: string
  createdAt: timestamp

/users/{userId}/teams/{teamId}
  id: string
  regulationId: string
  name: string
  createdAt: timestamp
  updatedAt: timestamp

/users/{userId}/teams/{teamId}/members/{slot}
  slot: number                     // 1-6
  speciesId: string
  nickname: string | null
  itemId: string
  abilityId: string
  nature: string
  moves: string[]                  // [moveId, moveId, moveId, moveId]
  evs: { hp, atk, def, spa, spd, spe }  // must sum <= 510, each <= 252
  ivs: { hp, atk, def, spa, spd, spe }
  computedStats: { hp, atk, def, spa, spd, spe }   // pre-computed
  inferredRole: string             // Claude-generated natural language role
  benchmarks: Array<{
    id: string,
    description: string,           // always natural language
    status: 'passing' | 'failing' | 'needs_review',
    lastChecked: timestamp
  }>
  benchmarkLastEvaluated: timestamp

/users/{userId}/teams/{teamId}/chatSessions/{sessionId}
  createdAt: timestamp
  updatedAt: timestamp

/users/{userId}/teams/{teamId}/chatSessions/{sessionId}/messages/{messageId}
  role: 'user' | 'assistant'
  content: string
  attachedDiff: object | null      // proposed changes if any
  diffStatus: 'pending' | 'accepted' | 'rejected' | null
  createdAt: timestamp
```

---

## Team Import / Export

**Import:** User pastes a Showdown export string. `@pkmn/sets` parses it into structured data. On import:

1. Validate all mons/moves/items against active regulation legal dex
2. Reject any mon, move, or item not legal in Reg M-B before proceeding
3. Compute final stats for each mon using stat formula
4. Claude infers role and benchmarks for all 6 mons simultaneously with full team context
5. Benchmarks are verified against current Pikalytics usage data (common spreads)
6. Benchmark cards are presented non-blocking — user can review, edit, or dismiss

**Export:** App generates a valid Showdown paste from current team state. One button copy.

**Two-way workflow:**
```
Build in Showdown → export paste → import to app (one click parse)
Build in app → export paste → import to Showdown (one click copy)
```

True background sync with Showdown is not possible (no official API). Import/export covers the workflow.

---

## UI Layout

### Regulation Selector

Persistent dropdown at the top of the app. Currently only Reg M-B. Switching regulation reloads Layer 3 context for the entire session. Claude never infers the regulation — it is always explicitly injected.

### Split Pane Interface

```
┌─────────────────────┬──────────────────────────────┐
│   CHAT              │   ARTIFACT PANEL              │
│                     │                               │
│  [message history]  │  [active view]                │
│                     │                               │
│  [input box]        │                               │
└─────────────────────┴──────────────────────────────┘
```

### Artifact Panel Views

Claude switches the active view automatically based on the query. User can also switch manually.

- **Team view (default):** 6 mon cards with set, computed stats, role, benchmark status indicators
- **Damage calc view:** Two mon panels + field panel in the middle, move list with damage ranges and full 16 rolls. Simplified UI by default; full options (weather, terrain, screens, boosts, etc.) behind "Advanced" toggle. Inspired by the Smogon damage calculator layout but with a simplified default state.
- **Speed tier view:** Full speed tier chart for loaded team + top meta mons, with Tailwind and Trick Room toggles
- **Threat table view:** Top Reg M-B usage mons ranked by threat level to the loaded team
- **Diff view:** Proposed changes to a mon's EVs, moves, or benchmarks with accept/reject controls

### Diff / Proposal Flow

When Claude proposes a change to a mon:

1. Diff view opens in the artifact panel
2. Shows current vs. proposed values for every changed stat
3. Shows EV budget delta (must remain ≤ 510 total)
4. Shows which benchmarks are affected and their new pass/fail status
5. Shows full reasoning: what is being raised, what is being cut, why, and what other benchmarks are or are not impacted
6. User accepts or rejects. Rejected diffs are logged in chat history.

**Example reasoning format:**
> "Raising Speed by 12 points (28 EVs) to outspeed Whimsicott in Tailwind. Keeping SpAtk at 252 — Flamethrower still OHKOs standard Landorus-T in Sun. Taking EVs from HP: drops from 89.3% to 85.1% survival vs. Moonblast from standard Flutter Mane, which is not a current benchmark."

Claude must always account for all existing benchmarks before proposing any change. A change that silently breaks a passing benchmark is never acceptable — it must be flagged in the diff.

---

## Benchmark System

### Inference on Import

Claude infers benchmarks from the full team context simultaneously, not per-mon in isolation. It considers:

- Moveset, item, nature, and EV spread of the imported mon
- The roles of the other 5 mons (what do they cover, what does this mon need to cover)
- Current Pikalytics usage data for Reg M-B (what threats are common enough to benchmark against)
- Reg M-B specific metagame context (Mega profiles, dominant archetypes, Fake Out patterns)

Benchmarks are always stored and displayed as natural language strings:
```
"OHKOs standard Mega Dragonite with Ice Beam before Multiscale check"
"Outspeeds max speed Whimsicott in Tailwind"
"Survives Adaptability Sludge Bomb from Mega Glimmora"
"Moves before Weavile's Fake Out under Trick Room"
```

### Benchmark Cards

Each mon has a benchmark card in the team view showing:
- Inferred role (editable in natural language)
- List of benchmarks with pass/fail status badges
- Last evaluated timestamp

### Editing Benchmarks

- Click any benchmark to edit it inline in natural language
- Say in chat "change Charizard's speed benchmark to outspeed Mega Aerodactyl instead" — Claude updates the benchmark and reruns the calc
- Say "Charizard is now my Trick Room setter, not my sun sweeper" — Claude re-infers all benchmarks for Charizard and flags which other team members' benchmarks are now in conflict

### Team Synergy Re-evaluation

When any mon's role changes, Claude re-evaluates all 6 mons' benchmarks in the context of the new team configuration and surfaces conflicts proactively. Synergy is the unit of analysis, not individual mons.

---

## Usage Data Pipeline

### Sources

| Source | Use Case | Cadence |
|---|---|---|
| Pikalytics | Primary — VGC tournament usage, common spreads with computed stats | Weekly during season |
| Limitless | Real tournament team sheets, winning builds | Post-event (1-2x/month) |
| `@pkmn/smogon` | Secondary usage stats, sanity check | Monthly |
| Pokemon Home | Official Nintendo usage, sanity check | Monthly |

### Caching Strategy

- Usage snapshots stored in Firestore per regulation + source + date
- App always queries the latest snapshot for the active regulation — never fetches live at query time
- All common spreads have pre-computed final stats stored alongside the EV/nature data so Claude references numbers directly
- Historical regulation snapshots are frozen when a new regulation becomes active

### Pikalytics Update Notifications

When a new Pikalytics snapshot is ingested:
1. Re-run all benchmark calcs for all saved teams in Reg M-B against the new common spreads
2. Any benchmark that changes status (passing → failing or failing → passing) is flagged
3. Next time the user opens that team, a notification appears: "Pikalytics updated — 2 benchmarks need review"
4. Affected benchmarks are highlighted in the benchmark card, showing old vs. new standard spread

---

## Claude Context Assembly (per query)

```typescript
async function buildQueryContext(userId: string, teamId: string, regulationId: string) {

  // Layer 1 — static constant, never fetched
  const layer1 = IMMUTABLE_MECHANICS_PROMPT; // content of ground-truth-vgc-mechanics.md

  // Layer 2 — loaded from Firestore, stable within gen
  const [species, moves, abilities, items] = await Promise.all([
    db.collection('species').where('gen', '==', 9).get(),
    db.collection('moves').where('gen', '==', 9).get(),
    db.collection('abilities').where('gen', '==', 9).get(),
    db.collection('items').where('gen', '==', 9).get(),
  ]);

  // Layer 3 — regulation + team
  const regulation = await db.collection('regulations').doc(regulationId).get();
  const legalDex = await db.collection(`regulations/${regulationId}/legalDex`).get();
  const usageSnapshot = await db.collection('usageSnapshots')
    .where('regulationId', '==', regulationId)
    .where('source', '==', 'pikalytics')
    .orderBy('snapshotDate', 'desc')
    .limit(30)
    .get();
  const teamMembers = await db
    .collection(`users/${userId}/teams/${teamId}/members`)
    .orderBy('slot')
    .get();
  const chatHistory = await db
    .collection(`users/${userId}/teams/${teamId}/chatSessions`)
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get();

  return buildSystemPrompt(layer1, regulation, legalDex, usageSnapshot, teamMembers, chatHistory);
}
```

### Assembled System Prompt Structure

```
[LAYER 1 — IMMUTABLE VGC MECHANICS]
Full type chart, damage formula, stat calc, priority brackets,
spread move rules, screen rules, status caps, PP table,
all Champions era universal rules.
Instruction: never estimate numbers, always call calc functions,
flag speed ties, validate legality before every calc, reject Tera queries.

[LAYER 2 — GEN 9 DATA]
Available via tool calls: species lookup, move lookup, ability lookup, item lookup.
Pinned to @pkmn/data v[x]. Mega overlays available for Reg M-B legal Megas.

[LAYER 3 — ACTIVE REGULATION: REG M-B]
Restricted slots: 2
Mega Evolution: enabled | Tera: disabled | Z-moves: disabled | Dynamax: disabled
Banned items: [...]
Protect variant PP: 8 PP (Protect, Detect, Baneful Bunker, King's Shield, Obstruct, Spiky Shield, Wide Guard)
Nihil Light PP: 8 PP (bypasses Fairy immunity — flag as tier-defining threat)
Hyper Drill: 120 BP, bypasses Protect
Unseen Fist: 25% damage through Protect
Sharpness Slicing moves: Dragon Claw (120 eff.), Shadow Claw (105 eff.), Night Slash (105 eff.), Dire Claw (75 eff.)
Moonblast SpAtk drop: 10% | Iron Head flinch: 20% | Dire Claw status proc: 30% (10% each)
Salt Cure: 6.25% standard / 12.5% Steel+Water

Dominant Mega threats:
- Mega Dragonite: Multiscale, base 100 speed, Tailwind setter
- Mega Glimmora: Adaptability Sludge Bomb, Toxic Debris
- Mega Aerodactyl: Unnerve, fast Tailwind
- Archaludon: Stamina, Electro Shot in Rain

Current usage leaders (Pikalytics, [date]):
[top 20 mons with usage %, common moves, common spreads with pre-computed stats]

Active team:
[all 6 mons with full sets, computed stats, inferred roles, benchmark list with pass/fail]

Before answering any query:
1. Confirm mon/move/item is legal in Reg M-B
2. Check EV budget (≤510 total) before any proposed change
3. Check all 6 mon benchmarks before proposing any EV change
4. Show full team-wide benchmark impact in every diff proposal
5. Never propose a change that silently breaks a passing benchmark
6. Always flag speed ties — never resolve them deterministically
```

---

## V1 Feature Scope

### In V1

- Regulation selector (Reg M-B only)
- Firebase Google auth + team library
- Showdown paste import + export
- Split pane UI: chat + artifact panel
- Damage calc view with move list and all 16 rolls (simplified default + Advanced toggle)
- Claude-inferred benchmarks on import with benchmark cards
- Natural language benchmark editing
- Team synergy re-evaluation on role change
- Diff proposal flow with accept/reject
- Speed tier view for loaded team with Tailwind/Trick Room toggles
- Threat assessment queries ("what should [mon] be worried about in Reg M-B?")
- Pikalytics usage cache (manual seed for V1, automated sync post-V1)
- Chat history persisted per team session

### Post-V1

- Automated Pikalytics sync job + benchmark re-evaluation notifications
- Limitless tournament set integration
- Lead pair optimizer
- Role compression detection
- Weakness/resistance matrix
- Reverse EV calc ("what EVs do I need to OHKO X?")
- Protect PP tracker during matches
- Multi-regulation support

---


## Data Freshness Rules

- **Layer 1:** Never updated at runtime. Fix in code, redeploy. Content is `ground-truth-vgc-mechanics.md`.
- **Layer 2:** Updated only when a new regulation launches. Pin the @pkmn/data version. Historical snapshots frozen.
- **Layer 3 regulation config:** Updated when Play Pokemon publishes a new regulation document. Official doc is ground truth for legality, not community speculation.
- **Layer 3 usage data:** Updated weekly (Pikalytics), post-event (Limitless). Always versioned by date in Firestore.
- **Mega overlay data:** Confirmed from official source before entry. Note the source in the notes field.
