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
