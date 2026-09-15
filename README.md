# Forge

A team builder and damage calculator for Pokémon Champions VGC, with an AI assistant that
reasons about teams but never invents a number. Live at [vgcforge.com](https://vgcforge.com),
hosted on Vercel with Firebase as the backend.

Every stat, damage roll, speed comparison, and legality verdict comes from code: a vendored
Champions build of `@smogon/calc` plus live Pikalytics usage data. The model (any of four
providers) calls those engines as tools and explains the results.

## What it does

- **Team editor.** Six slots with species, item, ability, nature, moves, and Stat Points (SP,
  the Champions replacement for EVs: 0–32 per stat, 66 total). The nature dropdown names the
  stats each nature raises and lowers, and typing `+` or `-` next to a stat's SP number (either
  side, "+12" or "12+") makes that stat the raised or lowered one. Move pickers are filtered by
  learnset, popular sets from Pikalytics apply with one click, and every set passes a legality
  gate for the active regulation.
- **Damage calc.** Attacker, defender, field, all 16 rolls, KO chance, Smogon-style description.
  Speed ties and Multiscale are flagged, never silently resolved.
- **Speed tiers.** Your team against the format's relevant speed benchmarks, with Tailwind and
  Trick Room toggles.
- **Threat matrix.** One set calced in both directions against the top of the live usage rankings:
  what it reliably OHKOes or 2HKOes, what reliably does that to it, the OHKO races where move order
  decides, and the standoffs. The assistant calls it as a tool before any claim about what a set or
  a team covers; `POST /api/threats` returns the same matrix without a key. No dedicated view yet.
- **Benchmarks.** Natural-language goals per Pokémon ("outspeeds max speed Whimsicott in
  Tailwind") that the model parses into a machine-checkable form and the engine evaluates.
  An SP optimizer searches for the smallest spread that passes them.
- **Assistant chat.** One chat surface that sees the current screen. Direct edits (switch the
  defender, turn on Trick Room, give Garchomp a Life Orb) apply immediately; suggestions arrive
  as accept/reject proposal cards.
- **Team builder.** Describe a team ("rain with a Trick Room mode") or place a few Pokémon and
  let the model fill the rest, researching with usage, speed, and damage tools. Runs one model
  round per request so it survives serverless timeouts.
- **Team library.** Saved teams with AI-written blurbs and suggested names. Saved in the browser
  until you sign in; signing in (or creating an account) moves anything saved in the browser
  into the account automatically, and from then on teams save to Firestore.
- **Showdown.** Paste import and export (EVs converted to SP), link a Showdown username (in the
  header's ⚙ Options menu) to see Champions ratings, recent replays, and public teams with
  one-click import, and share a team as a PokePaste.
- **Replay analysis.** Reads the actual battle logs behind a player's recent replays and counts
  what they bring out of their six, what they lead, their record, and how they do into Trick Room,
  Tailwind, sun, rain, and the rest. No model is involved: every number is counted out of a log.
  `GET /api/showdown/replay-analysis` today; not wired into the Showdown panel yet.
- **Regulations.** Reg M-B (the base Champions dex) and Reg M-C (Sep 9 – Dec 2, 2026). A
  regulation is a delta over the base dex; see `src/lib/rulesets/`.

## AI access

Visitors either connect their own key (OpenAI, Gemini, Anthropic, or OpenRouter) or use the
site's free tier. Visitors choose a provider only; the server picks the model per job
(`modelFor` in `src/lib/ai/llm.ts`). Connected keys are validated with the provider, sealed
into an httpOnly cookie with AES-256-GCM, and never stored server-side.

The free tier runs on the owner's key from the environment with no sign-in required. It is
capped per visitor (`FREE_CHAT_LIMIT`, counted in the Firestore `aiQuota` collection when admin
credentials are present): the Firebase account when signed in, otherwise a signed device
cookie. Connecting your own key works signed in or not. Only requests the visitor explicitly triggers
(chat, team builder, SP optimizer, benchmark parsing) spend it. Ambient features (compare
chips, blurbs, role inference) run only on a connected key and fall back to deterministic
behaviour without one.

## Stack

| Layer | Technology |
|---|---|
| App | Next.js 16 App Router, React 19, TypeScript, Tailwind 4 |
| Calc engine | Vendored `@smogon/calc` master build with Champions as generation 0 (`vendor/smogon-calc`) |
| Dex data | The vendored calc dataset, with Reg M-C additions and learnsets grafted from `@pkmn/dex` (corrected by Pikalytics usage) |
| Usage data | Pikalytics AI endpoint, fetched live; cached fresh for 6h and served stale for up to a day (`src/lib/cache/`) |
| Auth | Firebase Auth (Google and email/password), project `pokemon-vgc-tool` |
| Database | Firestore: `users/{uid}/teams` for the library, `aiQuota` for the free-tier counter, `cache` for the persistent server cache |
| LLM | Provider-neutral client over `@google/genai`, the Anthropic Messages API, and OpenAI-compatible chat completions |
| Hosting | Vercel (vgcforge.com), serverless functions; Firebase provides auth and Firestore |

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in at least one AI key and the Firebase web config
npm run dev                  # http://localhost:3000
```

`npm run build` type-checks and builds. `npm run lint` runs ESLint.

Without any AI key the app still works as a calculator and team editor. Without Firebase
config the app stays in guest mode with localStorage teams. Without Firebase admin
credentials the free-tier counter lives in memory and resets on restart, and the persistent
cache degrades to memory-only: still a cache, but per-process, gone on restart, and shared
with nothing.

Firestore rules and indexes deploy with `firebase deploy --only firestore` (the CLI is
pointed at `pokemon-vgc-tool` by `.firebaserc`). Auth authorized domains are listed in
`firebase.json`.

## Repository map

```
src/app/api/            Route handlers (all Node runtime; the calc dataset is 2.3 MB CJS)
  chat, build-team, optimize-sp, compare-set, team-blurb, eval, benchmark/parse
  import, calc, learnset, usage, ruleset, ai-key, threats
  showdown/{profile,replays,teams,team,share,replay-analysis}
src/components/         Workspace (root client component), TeamView, DamageCalcView,
                        SpeedTierView, ChatPanel, TeamBuilderPanel, TeamLibrary,
                        SpEditor, PopularSets, CompareStrip, AiKeyControl, AuthPanel,
                        showdown/ShowdownPanel
src/hooks/              useChampionsChat, useLearnset, useShowdown, useUsage
src/lib/ai/             llm (provider client), credential (BYOK + free tier), quota,
                        tools (shared tool declarations + legality gate; the threatMatrix
                        tool is declared in calc/threats and re-exported here), gemini
                        (chat runner), buildTeam, compareSet, benchmarks (role inference)
src/lib/calc/           engine (the only source of numbers), sp (Stat Point system),
                        threats (two-way matchup matrix vs the live rankings)
src/lib/cache/          persistent (tiered L1 memory + L2 Firestore cache), admin (inspect, purge)
src/lib/data/           champions (dex accessors), usage (Pikalytics), learnsets, meta
src/lib/rulesets/       Regulation registry: reg-m-b, reg-m-c
src/lib/benchmarks/     parse (NL to check), evaluate (engine verdict), types
src/lib/library/        Team store interface, localStorage and Firestore adapters
src/lib/chat/           Per-team assistant conversations (localStorage threads keyed by team id)
src/lib/showdown/       import, export, psApi, replayAnalysis (battle-log mining)
src/lib/firebase/       client (web SDK), server (ID token verify + Firestore REST, no admin SDK)
context/                Design docs and mechanics ground truth (see below)
vendor/smogon-calc/     Vendored calc build with provenance and a required local patch
firestore.rules         Owner-only team library rules, kept cheap for the evaluation budget
                        (`aiQuota` and `cache` are server-owned and denied to clients)
```

## Documentation

- `context/vgc-champions-tool-spec.md`: architecture and product spec as built.
- `context/ground-truth-vgc-mechanics.md`: universal Champions-era doubles mechanics.
- `context/ground-truth-reg-mb.md`: Reg M-B rules and metagame, the baseline the rulesets extend.
- `vendor/smogon-calc/README.md`: why the calc is vendored, the pinned commit, and how to rebuild.
- `CLAUDE.md` / `AGENTS.md`: instructions for coding agents, including the rule that these
  documents are updated in the same change as the code they describe.
