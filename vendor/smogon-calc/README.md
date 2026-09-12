# Vendored `@smogon/calc` (Champions / gen 0)

The published npm `@smogon/calc` (v0.11.0) does **not** include Pokémon Champions support.
Champions is implemented on the `smogon/damage-calc` **master** branch as **generation `0`**
(`MOVES[0]` / `SPECIES[0]`, `calcStatChampions`, `mechanics/champions.ts`). This directory
vendors a build of that branch so the app can use it until Champions ships to npm.

## Provenance
- Source: https://github.com/smogon/damage-calc (`calc/` subpackage)
- Pinned commit: `c246cab73473f05375396bf74cae1e9ce895309b` (2026-06-25, "Update sets")
- Layout: the compiled `dist/` contents are placed at the package root (mirrors the published
  layout) so both `@smogon/calc` and `@smogon/calc/data` resolve. No runtime dependencies.

## Local patch (must be reapplied after any rebuild)
`mechanics/champions.js` (the knock-off resist code) calls `gen.items.get(toID(defenderItem))` and then
dereferences `item.megaStone`. For gen 0 (Champions), `gen.items.get()` returns `undefined` for any
*inherited* item (e.g. Safety Goggles, Life Orb) because the gen-0 item table only holds Champions-new
items — so any calc where the **defender holds a common item** crashed. We guard it:
```js
// resistedKnockOffDamage = !!(item.megaStone && ...)   // original (crashes)
resistedKnockOffDamage = !!(item && item.megaStone && ...)   // guarded
```
Reapply this guard after rebuilding (or upstream the fix).

## Known defect in the gen-0 move table (worked around in app code, not patched here)

`data/moves.js` builds the Champions table as:
```js
var CHAMPIONS = extend(true, {}, Object.fromEntries(CHAMPIONS_LIST.map(m => [m, SV[m]])), CHAMPIONS_PATCH);
```
`SV` is a per-generation **delta** table, so `SV[name]` is `undefined` for any move that Gen 9 did
not itself change. For those moves the Champions entry ends up holding only whatever
`CHAMPIONS_PATCH` supplies — usually just a rebalanced `bp` — and the move's `type`, `category`,
`target` and flags are lost. `MOVES_BY_ID` builds each generation independently with no inheritance,
and the `Move` constructor's `category ??= 'Status'` default is gated on `gen >= 4`, so at gen 0
both fields simply stay `undefined`.

Effect: **84 of 513 gen-0 move entries are incomplete.** 72 lose only their category (all of them are
status moves, so no damage was affected). The remaining 12 lose type *and* category, and
`calculate()` returns **0 damage for all of them against every target** — silently, with no error:

> Anchor Shot, Astral Barrage, Blood Moon, Bolt Beak, Dragon Hammer, Fishious Rend, Gear Grind,
> Hyper Drill, Metal Claw, Revelation Dance, Snipe Shot, Triple Dive

(`Metal Claw` is the worst case: its entire gen-0 entry is `{isSlicing: true}`, so it has no base
power either.)

This is **not** patched in the vendor. `src/lib/data/champions.ts` refills the missing fields from
`@pkmn/dex` and feeds them back through the calc's own `options.overrides` merge, keeping the gen-0
base power (which is the Champions-specific value — Astral Barrage is 110 here, 120 in Gen 9).
Repairing in app code rather than in `data/moves.js` means there is nothing extra to reapply after a
rebuild: if a future build fixes the table upstream, the repair layer finds nothing to repair and
becomes a no-op on its own. Re-check `repairedMoves` after any rebuild to confirm the count drops.

## Gotcha: `fullDesc(notation)` defaults to 48ths, not percent

`Result.fullDesc(notation)`, `moveDesc`, `recovery` and `recoil` all render **48ths of max HP** (HP-bar
pixels) for any `notation` other than the literal `'%'` — see `toDisplay` in `desc.js`. Passing `''`
does not mean "no unit", it selects the 48ths branch: a 101–119% hit prints as `187-221 (48 - 57)`.
Pass `'%'` (or no argument). This is upstream behaviour, not a defect of this build, but it
misreported every damage description in the app until it was caught; `src/lib/calc/engine.ts`
now pins the notation and re-derives the printed percent from `minPct`/`maxPct`.

## How to rebuild / update
```bash
git clone https://github.com/smogon/damage-calc.git
cd damage-calc/calc
git checkout <commit>
npm install --ignore-scripts          # --ignore-scripts skips the broken browser-bundle step
./node_modules/.bin/tsc -p .          # emits dist/
# then copy dist/* into vendor/smogon-calc/ (drop production.min.js) and reapply the Local patch above
```

## Usage (Champions = gen 0)
```ts
import { calculate, Pokemon, Move, Field } from '@smogon/calc';
import { Generations } from '@smogon/calc/data';
const gen = Generations.get(0);                       // 0 = Champions
// SP is passed through the `evs` field for gen 0; IVs are ignored (always 31), level is 50.
const atk = new Pokemon(gen, 'Staraptor', { item: 'Choice Band', ability: 'Reckless',
  nature: 'Adamant', evs: { atk: 32 } });
```

## Remove this vendor when
`@smogon/calc` publishes a release containing Champions. Then replace the `file:` dependency
in the root `package.json` with the published version and delete this directory.
