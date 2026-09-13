# Forge — Architecture and Product Spec (as built)

Last reconciled with the code: 2026-09-12. When the code changes, this file changes in the same
commit (see `CLAUDE.md`).

## Overview

Forge is a public team builder and damage calculator for Pokémon Champions VGC, deployed on
Vercel at vgcforge.com with Firebase as the backend. It combines a deterministic Champions calc engine with an AI assistant that
interprets natural-language requests, edits the screen, proposes set changes, builds teams, and
reasons about synergy. Every numeric output is computed by code. The model never estimates a
number; it calls engine tools and explains the results.

The original design was a single-user tool on the Claude API with a Firestore data warehouse.
What shipped is multi-user, provider-neutral, and keeps all dex and usage data outside Firestore.
The section at the end lists what was dropped or deferred.

Ground truth for mechanics lives in two companion documents:
- `ground-truth-vgc-mechanics.md`: universal Champions-era doubles rules.
- `ground-truth-reg-mb.md`: Regulation M-B rules and metagame, the baseline the rulesets extend.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind 4, TypeScript |
| Backend | Next.js route handlers, Node runtime, serverless |
| Calc engine | Vendored `@smogon/calc` master build, Champions as generation 0 (`vendor/smogon-calc`) |
| Dex data | The vendored calc dataset; Reg M-C additions and learnsets grafted from `@pkmn/dex` |
| Usage data | Pikalytics AI endpoint, fetched live, cached in two tiers (see Caching) |
| Auth | Firebase Auth: Google popup and email/password. Phone sign-in was removed. |
| Database | Firestore, project `pokemon-vgc-tool` |
| LLM | Provider-neutral client (`src/lib/ai/llm.ts`) over OpenAI, Gemini, Anthropic, OpenRouter |
| Hosting | Vercel at vgcforge.com. Route handlers run as Vercel serverless functions, which is why every request fits a single model call. Firebase (auth, Firestore) is the backend; `pokemon-vgc-tool.web.app` / `.firebaseapp.com` are authorized auth domains only |

---

## Regulations

Two regulations are registered in `src/lib/rulesets/index.ts`. The default is Reg M-C, the
regulation currently in season.

| Id | Label | Window | Usage format |
|---|---|---|---|
| `reg-m-b` | Regulation M-B | through 2026-09-08 | `gen9championsvgc2026regmb` |
| `reg-m-c` | Regulation M-C | 2026-09-09 to 2026-12-02 | `gen9championsvgc2026regmc`, with M-B as the per-species fallback for spreads |

The vendored gen-0 dex *is* the Reg M-B pool, so the M-B delta is empty. Reg M-C adds 36 usable
Pokémon (31 dex names), 12 held items plus the Mega Stones the new Megas need, and the signature
moves the gen-0 move table lacks. Species and moves not in the vendored data are grafted from
`@pkmn/dex` into the same shape so the legality gate and engine treat them like native entries.

Format facts common to both: Level 50, bring 4 of 6, Mega Evolution on, no Terastallization,
no Z-moves, no Dynamax. Stat Points replace EVs and IVs (0–32 per stat, 66 total; IVs fixed at
31). Tera input to the engine is rejected before any calc runs.

The header selector switches regulation instantly: `page.tsx` computes form lists for every
ruleset on the server once. Switching does not touch the open team; saved teams carry the
`regulation` they were last saved under. `/api/ruleset` reports whether usage numbers are on
fallback data so the header badge can say so.

**Adding a regulation:** one file satisfying `Ruleset` in `src/lib/rulesets/`, registered in
`index.ts`, plus the id added to the `regulation` check in `firestore.rules`. Nothing else in the
codebase should need to know the regulation's specifics.

---

## Model context: three layers

Every assistant request is assembled from three layers. None of them is loaded from Firestore.

1. **Mechanics (static).** The engine itself enforces Champions mechanics; the qualitative
   baseline the model is told lives in `src/lib/data/meta.ts` and must stay traceable to the two
   ground-truth documents. No usage claims are allowed in static text.
2. **Dex data (tools).** Species, moves, items, abilities, and learnsets are answered by tools
   over the vendored dataset (`src/lib/data/champions.ts`, `learnsets.ts`).
3. **Regulation, usage, and screen (per request).** The active ruleset's notes, live Pikalytics
   usage via `lookupUsage`, and a serialized snapshot of what is on screen (team, calc state,
   speed-tier state) so the model edits what the user is actually looking at.

Whether a set covers the metagame is also a tool answer, not a judgement: `threatMatrix`
(`src/lib/calc/threats.ts`) calcs one set both ways against the top of the live rankings and hands
back a per-opponent verdict plus a prose summary. Chat and the team builder are told to call it
before any claim about what something beats, walls, or loses to, and to cite what it returned.

Standing instructions to the model: never estimate numbers, call the engine, flag speed ties,
validate legality before proposing anything, respect the 66-SP budget, and account for existing
benchmarks before changing a spread.

---

## AI access

Visitors choose a provider; the server chooses the model per job.

- **Bring your own key.** `POST /api/ai-key` validates the key with the provider and seals it
  into an httpOnly, `sameSite=strict` cookie scoped to `/api` (AES-256-GCM under
  `AI_COOKIE_SECRET`, 90 days). It is never stored server-side and JavaScript never reads it.
  No quota applies.
- **Free tier.** The owner's key from the environment, chosen in the order OpenAI, Gemini,
  Anthropic, OpenRouter unless `FREE_TIER_PROVIDER` forces one. Requires a signed-in Firebase
  account (ID token verified server-side against Google's certificates, no admin SDK).
  Capped at `FREE_CHAT_LIMIT` requests per account (default 15). The counter lives in the
  Firestore `aiQuota` collection through the REST API when `FIREBASE_ADMIN_*` is set, otherwise
  in process memory. The limit and count are never sent to the browser. A failed upstream call
  refunds the request. Anonymous visitors get a signed device cookie for identity but are asked
  to sign in or connect a key before using the free tier.
- **Interactive vs ambient.** Chat, team builder, SP optimizer, and benchmark parsing are
  interactive: own key, else free tier, else denied. Compare chips, team blurbs, team names,
  role inference, and benchmark re-parsing on evaluation are ambient: own key only, with a
  deterministic fallback (top of the usage rankings, blank blurb, blank role).
- **Model tiers.** Each provider maps `fast` (short structured picks) and `smart` (tool loops)
  to a model in `PROVIDERS`; `AI_MODEL_<PROVIDER>_<TIER>` overrides one. Tool schemas are
  written once in Gemini's `Type.OBJECT` form and converted for the other providers.
  OpenRouter requests carry Forge / vgcforge.com attribution headers.

---

## Engine and data

- `src/lib/calc/engine.ts` is the only source of numbers: `calcDamage` (16 rolls, min/max,
  percent of max HP, KO chance, description, caveat flags for speed ties and Multiscale),
  `compareSpeed`, and `computeStats`. Champions SP is passed through the calc's `evs` field.
- `src/lib/calc/sp.ts` documents the stat formula (HP = base + SP + 75; other =
  floor(nature × (base + SP + 20))) and clamps every SP input to the budget. It also owns the
  nature helpers the UI shares: `natureEffect` / `natureLabel` (which stats a nature raises and
  lowers, shown in every nature dropdown), `natureFor` (the nature for a raised/lowered pair, the
  missing side filled from the spread: lowest-SP stat for the drop, highest for the raise), and
  `parseSpInput` (a typed SP value with an optional `+` / `-` before or after the number).
- `src/lib/data/usage.ts` fetches `https://www.pikalytics.com/ai/pokedex/{format}/{pokemon}`
  as markdown and parses it. Out of each species page: headline usage, win rate and W-L(-T)
  record; common moves, items and abilities; the most common teammates (co-occurrence, the
  evidence for synergy claims); the defensive type-matchup chart with Pikalytics' ability caveat;
  the FAQ's top spread; and up to ten featured tournament teams, each carrying the focal set *and*
  the full six-Pokémon composition it was played on. A fetched page that parses to nothing is
  treated as parser drift and returns null rather than empty data. Unpublished formats are
  re-probed every five minutes. Upstream calls time out at ten seconds.
- **Predecessor-format spread fallback.** The FAQ spread is the one field Pikalytics leaves empty
  on a newly launched regulation, and under Mega/forme names. `fetchUsage` retries that field only
  — first the base species in the current format, then the predecessor format — and records where
  a borrowed spread came from in `topSpreadSource`, so `lookupUsage` can tell the model to call it
  the previous regulation's spread rather than this one's. A measured spread always beats a
  borrowed one.
- `src/lib/calc/threats.ts` builds the threat matrix: it rebuilds each of the top-ranked opponents
  from their own usage data and runs `calcDamage` in both directions, capped at 30 opponents and
  four moves a side. Every number comes from the engine; KO tiers are arithmetic over the engine's
  own rolls, and "OHKOes" and "rolls to OHKO" stay distinct. It declares and executes the
  `threatMatrix` tool itself, so `lib/calc` never imports `lib/ai`.
- `src/lib/showdown/replayAnalysis.ts` parses Showdown battle logs into deterministic facts — team
  preview, what was brought, leads, archetype markers, result — and aggregates a player's recent
  replays in one format. No model is involved. One format id per call, at most 25 replays, and a
  log that does not yield the facts it needs is excluded and reported rather than counted.
- `src/lib/data/learnsets.ts` is a Gen 9 graft (Champions publishes no learnset table). Verdicts
  are three-state; a move is rejected only with positive evidence, so Champions-only signatures
  are never blocked.
- `src/lib/ai/tools.ts` holds the shared tool declarations (`calcDamage`, `lookupUsage`,
  `compareSpeed`, and `threatMatrix` re-exported from `calc/threats.ts`) and the legality gate
  every AI entry point uses. A set that is illegal for chat is illegal for the team builder and
  compare sets too. `executeSharedTool` dispatches all four; chat and the team builder declare all
  four, while `/api/optimize-sp` deliberately declares only `calcDamage` (its loop is a bounded SP
  search, not research).

---

## Persistence

Firestore holds three things: the team library, the free-tier counter, and the persistent cache.
Everything else (dex, chat history) is computed or fetched per request; nothing in the cache is
authoritative, since every entry is derived data that can be recomputed.

```
users/{uid}/teams/{teamId}     SavedTeam + ownerUid. Owner-only read/write.
aiQuota/{identityHash}         { used: int }. Server-only via REST; denied to clients.
cache/{namespace}/entries/{h}  Cache payload + TTL metadata. Server-only via REST; denied to clients.
```

`SavedTeam` (`src/lib/library/types.ts`): `id`, `name`, `team` (six slots, null or `TeamMon`),
`blurb`, `blurbHash`, `createdAt`, `updatedAt` (Unix ms), optional `regulation`. `TeamMon`
carries `slot`, `nickname`, `species`, `item`, `ability`, `nature`, `sp`, `moves`,
`computedStats`, `role`, `benchmarks`.

`firestore.rules` pins the schema shape and size caps but validates nested values only
shallowly: Firestore's per-request expression budget is exceeded by a field-by-field check of
six Pokémon. Only the owner can write, so value-level checks of the owner's own data are left
to the client. Keep `isValidMon` cheap.

Guests use a localStorage adapter with the same async `TeamStore` interface. Chat history is
kept in React state for the session and is not persisted.

---

## Caching tiers

`src/lib/cache/persistent.ts` is the one cache every server module uses. L1 is an in-process `Map`
(sub-millisecond, private to a lambda instance, gone on cold start); L2 is the Firestore `cache`
collection written as the service account, so a value survives cold starts, is shared across
instances, and outlives a deploy. A read checks L1, then L2, then the loader. Without
`FIREBASE_ADMIN_*` there is no L2 and the whole thing degrades to L1-only — still single-flight,
TTL and negative caching, but per-process and gone on restart.

Every key carries a namespace and a **schema version**. The version is part of both the L1 key and
the L2 document id, so bumping it when a parsed shape or a derived answer changes strands every old
entry instantly; stale-shaped JSON can never reach newly typed code. Two policies cover the call
sites:

| Policy | Lifetime | Used by |
|---|---|---|
| `LIVE_DATA` | fresh 6h, stale-servable 18h, negatives 5 min | `usage.ts`: species pages and format landing pages |
| `DETERMINISTIC` | kept until the version moves, keyed by a content hash of every input | `threats.ts` matrices, `replayAnalysis.ts` parsed replays |

Negative results get their own short lifetime, which is how an unpublished regulation, a 404, or a
parse failure is re-probed in minutes rather than held for the success TTL. Transport failures are
not cached at all. A `DETERMINISTIC` key must contain everything the answer depends on — for a
threat matrix that is the resolved focal set, the ruleset, the opponent count, and the resolved
usage snapshot the opponents were built from — because anything left out is served stale forever
rather than missing. Replay aggregates are the one entry kept out of L2 (`l1Only`): they are keyed
by a Showdown username, and the shared tier is for format-wide data only. `src/lib/cache/admin.ts`
lists, summarizes, and purges L2 from a script; it is not for the request path.

---

## UI

Root client component: `src/components/Workspace.tsx`. Two modes.

- **Library** (initial): card grid of saved teams with inline rename, sprites, AI blurb,
  Import, New Team, Export, Duplicate, Delete. The Showdown panel lives here: link a username
  (never a password) to see Champions ratings, the five most recent replays in the active
  format, and public teams with an Import button each, or import from a `psim.us/t/…` or
  `teams.pokemonshowdown.com/view/…` link.
- **Editor**: tab bar over three views plus the chat panel. Leaving with unsaved changes opens
  a save prompt. Save, Export, and Import live in the toolbar's overflow menu; the team name
  is edited inline, and the first save suggests names when the name is a placeholder.

Views (`WorkspaceView`): `team`, `calc`, `speed`.

- **Team.** Six slot editors with learnset-filtered move pickers, move and item descriptions,
  popular-set chips from Pikalytics, the shared `SpEditor` (slider plus number per stat, Max
  button, live computed stat, remaining budget; a `+` or `-` typed on either side of the number
  sets that stat as the nature's raised or lowered one, in the calc editors too), a role line,
  and the benchmark list. The team
  builder panel shows while slots are open.
- **Damage calc.** Two set editors and a field panel; move list with all 16 rolls. Compare
  chips suggest opponents relevant to the focus Pokémon.
- **Speed tiers.** The team against relevant benchmarks with Tailwind and Trick Room toggles.
  Compare chips pick the speed benchmarks around the focus Pokémon's bracket.

**Chat** is the single assistant surface. Every message goes out with the current screen state.
Direct tools (`navigateTo`, `updateCalc`, `updateSpeedTier`, `applyTeamEdit`, `setTeamSlot`,
`removeTeamSlot`, `reorderTeam`, `renameTeam`) apply immediately. Proposal tools
(`proposeTeamEdit`, `proposeBenchmark`, `proposeSubstitution`) render accept/reject cards
attached to the message. Every proposed set passes the legality gate before it reaches the UI.

---

## Benchmarks

Benchmarks are natural-language strings per Pokémon, added manually or through chat. They are
no longer auto-generated on import (that was dropped; roles are still inferred on import when a
key is connected).

1. `POST /api/benchmark/parse` turns the description into a structured `check` (interactive).
2. `POST /api/eval` runs every check through the engine and returns pass, fail, or needs review
   with the engine's own detail line. Benchmarks that still lack a check are re-parsed only on
   a connected key.
3. `POST /api/optimize-sp` asks the model to search for the minimum SP spread that passes the
   Pokémon's benchmarks using `calcDamage`; the engine re-verifies the returned spread and the
   budget before accepting, and rejections go back into the loop.

---

## Team builder

`POST /api/build-team` runs one model round per request. The first call charges one free
request (or uses the visitor's key), prepares signed `BuildState`, and runs round one;
continuations pass the state back and are never re-charged. The model researches with the
shared tools and finishes by calling `submitTeam`. Slots the user already filled are locked
server-side. A build is typically 5–15 rounds, hard-capped at 40.

---

## Import and export

- **Import** (`POST /api/import`, `src/lib/showdown/import.ts`): parses a Showdown paste.
  Values labelled EVs or above 32 are converted with SP = round(EV / 8); IVs are ignored.
  Every member is validated against the active ruleset and learnsets, stats are computed, and
  roles are inferred when a key is connected.
- **Export** (`src/lib/showdown/export.ts`): one-click Showdown paste from the current team.
- **Showdown API** (`src/lib/showdown/psApi.ts`, server-only for CORS): profile ratings, replay
  search, public team search, single team fetch, and PokePaste creation. Replay *logs* are read by
  `replayAnalysis.ts`, which shares this module's User-Agent and its replay search. No Showdown
  password is ever requested or stored, and only public replays are readable.

---

## API routes

All routes run on the Node runtime because the calc dataset is 2.3 MB of CommonJS.

| Route | Purpose | AI |
|---|---|---|
| `POST /api/chat` | Assistant turn with screen context | interactive |
| `POST /api/build-team` | One team-builder round | interactive (first round charged) |
| `POST /api/optimize-sp` | Minimum SP spread for benchmarks | interactive |
| `POST /api/benchmark/parse` | NL benchmark to structured check | interactive |
| `POST /api/eval` | Evaluate benchmarks with the engine | ambient re-parse only |
| `POST /api/compare-set` | Opponent chips for calc and speed views | ambient, rankings fallback |
| `POST /api/team-blurb` | 2–3 sentence team overview | ambient, empty fallback |
| `POST /api/import` | Parse and validate a paste, infer roles | ambient roles |
| `POST /api/calc` | Damage calc for the UI | none |
| `POST /api/threats` | Threat matrix for one set against the live rankings | none |
| `GET /api/learnset` | Learnable vs unverified moves for a species | none |
| `GET /api/usage` | Pikalytics usage for a species | none |
| `GET /api/ruleset` | Active ruleset and usage fallback status | none |
| `GET/POST/DELETE /api/ai-key` | Inspect, connect, or remove a key | none |
| `GET /api/showdown/profile`, `/replays`, `/teams`, `/team`; `POST /api/showdown/share` | Showdown integration | none |
| `GET /api/showdown/replay-analysis` | Bring rates, leads, record and matchup splits counted out of a player's replay logs | none |

---

## Environment

See `.env.example` for every variable with its default. Groups: AI keys and free-tier controls,
`AI_COOKIE_SECRET`, the public Firebase web config, and the Firebase admin service account used
only for the quota counter.

---

## Dropped or deferred from the original design

Kept here so the history is not lost and so nobody re-derives it.

- Firestore collections for regulations, species, moves, abilities, items, usage snapshots,
  tournament sets, and chat sessions. Replaced by the vendored dataset, live Pikalytics, and
  per-session chat state. (Usage snapshots came back as cache entries rather than as a data
  model — see the reversal note below.)
- Claude API as the only model. Replaced by the provider-neutral client and BYOK.
- Google OAuth as the only sign-in. Email/password was added; phone sign-in was added and removed.
- Automatic benchmark inference on import, and benchmark re-evaluation notifications when usage
  data updates.
- Diff view as a separate panel (proposals are inline cards instead) and the regulation-scoped
  Mega overlay collection.
- Limitless tournament sets, Pokémon Home stats.
- Still open:
  - Lead pair optimizer. Lead-pair win rates from real games now exist
    (`GET /api/showdown/replay-analysis` counts them out of battle logs), but nothing turns them
    into a recommendation, so the optimizer itself is still unbuilt.
  - Team-wide weakness/resistance matrix. Per-species defensive type matchups now arrive with
    `lookupUsage`, and the threat matrix covers the damage side, but nothing lays the six out as
    one type chart.
  - Role compression detection, reverse damage calc as a first-class view, Protect PP tracker,
    persisted chat history.

**Reversed — dropped, then built after all:**

- *Threat table.* Listed here as dropped. The matrix behind it is now built and is engine-backed:
  `src/lib/calc/threats.ts`, `POST /api/threats`, and the `threatMatrix` tool. Only the dedicated
  view is still missing; the assistant reads the matrix and cites it in prose instead.
- *Pikalytics snapshot caching in Firestore.* Dropped so that Firestore would not become a data
  warehouse. It came back in a narrower form: the L2 tier of the shared cache (see **Caching
  tiers**) stores derived payloads under a TTL and a schema version in the `cache` collection.
  Nothing there is authoritative, nothing is queried, and every entry can be thrown away and
  recomputed — which is what kept the original objection from applying.
