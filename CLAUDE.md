@AGENTS.md

# Forge (Pokémon VGC Tool)

Read `README.md` first. It is the accurate overview of what the app does and how it is laid out.
`context/vgc-champions-tool-spec.md` is the architecture spec as built. The two
`context/ground-truth-*.md` files are mechanics ground truth, not implementation docs.

## Keep the documentation accurate

Documentation is part of every change, not a follow-up. After any change that affects
behaviour, structure, data, or setup, update the documents it touches in the same commit:

- `README.md`: features, stack table, running locally, repository map, environment notes.
- `context/vgc-champions-tool-spec.md`: architecture, data model, AI access, regulations,
  API routes, and the "not built" list. If you implement something from that list, move it.
- `context/ground-truth-reg-mb.md` and `context/ground-truth-vgc-mechanics.md`: only when a
  mechanic or regulation fact changes. Cite the source. `src/lib/data/meta.ts` must stay
  traceable to these files.
- `.env.example`: every environment variable the code reads, with its real default.
- `firestore.rules` header comment: whenever `SavedTeam` or `TeamMon` changes shape.
- `vendor/smogon-calc/README.md`: whenever the vendored calc is rebuilt or repatched.
- File header comments in `src/`: they describe what each module guarantees. Fix them when the
  guarantee changes.
- The vault project note at `~/Documents/Projects/_index/Pokemon VGC Tool.md` (outside this
  repo): update the prose in its Notes section when the project's status, deployment, or
  direction changes. Never hand-edit its derived frontmatter; run
  `python3 ~/Documents/_maintenance/refresh.py --only="Pokemon VGC"` instead.

Before finishing, re-read the sections you touched and check that nothing in them contradicts
the code. Stale documentation is worse than none.

## Ground rules that the docs depend on

- Every number comes from the engine (`src/lib/calc/engine.ts`) or Pikalytics. The model only
  calls tools and explains. Do not add usage claims or numbers to static prompt text.
- Regulations are deltas in `src/lib/rulesets/`. Nothing else should know a regulation's
  specifics.
- Visitors choose an AI provider only; the server picks the model per job in
  `src/lib/ai/llm.ts`. Keys live in httpOnly cookies, never server-side.
- The app is hosted on Vercel; API routes are serverless functions and must fit a single
  model call per request. Long loops are split into rounds with signed state handed back to
  the browser (see `/api/build-team`). Firebase (Auth, Firestore) is the backend.
- Firestore rules have a per-request expression budget. Keep `isValidMon` cheap.
