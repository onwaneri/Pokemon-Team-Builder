# Ground Truth: Pokémon Champions Regulation M-B

This document is the authoritative reference for all Regulation M-B specific rules, mechanics, and metagame context. All VGC general mechanics in the VGC Mechanics ground truth document apply in full unless explicitly overridden here.

> **Status (2026-09-12):** Regulation M-B ended on 2026-09-08. Regulation M-C (2026-09-09 to
> 2026-12-02) is the live ranked format. This document is still the baseline: the vendored
> Champions dex in the app is the M-B pool, and every later regulation is a delta on top of it
> (`src/lib/rulesets/reg-m-c.ts` lists the M-C additions with its source). The qualitative
> context the model is given (`src/lib/data/meta.ts`) is traceable to this file; usage figures
> are never taken from here, they come from live Pikalytics data. Mentions of "current" below
> describe M-B during its season.

---

## 1. Regulation M-B Overview

Regulation M-B was the Pokémon Champions ranked format through 2026-09-08. It represents a structural shift away from passive stall and high-variance status reliance ("hax") toward a paradigm of Active Positioning and tactical execution.

**Defining mechanic: Dynamic Speed.** Unlike legacy formats where turn order was fixed at the start of the turn, Champions calculates turn order immediately mid-turn. If a Pokémon's speed is altered via Tailwind, Icy Wind, or an ability activation (e.g., Swift Swim), speed brackets update instantly.

---

## 2. Regulation M-B Config

```
id: reg-m-b
gen: 9
team_size: 6 (bring 4)
restricted_slots: 2
mechanic_tera: false
mechanic_megas: true
mechanic_zmoves: false
mechanic_dynamax: false
```

**No Terastallization.** Any query involving Tera types or Terastallization is invalid in this regulation. Reject before running any calc.

**Mega Evolution is enabled.** Mega stats are tracked in the species_mega_overlay table. Always use Mega stats (not base stats) for a Pokémon that has Mega Evolved.

---

## 3. Priority Brackets (Reg M-B Specific Values)

These values supersede standard Gen 9 priority where they differ.

| Bracket | Moves |
|---|---|
| +5 | Helping Hand |
| +4 | Protect, Detect, Spiky Shield, Wide Guard, Baneful Bunker, King's Shield, Obstruct |
| +3 | Fake Out |
| +2 | Extreme Speed, Follow Me, Rage Powder |
| +1 | Sucker Punch, Aqua Jet, Bullet Punch, Mock Punch |
| 0 | Standard moves |
| -7 | Trick Room |

**Fake Out (Reg M-B rule):** Cannot be selected after the first turn the user is on the field.

**Sucker Punch:** Fails if the target uses a non-damaging move or moves first in the same bracket.

**Protect variants PP cap:** All Protect variants are capped at 8 PP in Reg M-B. Track PP usage — forcing an opponent to exhaust their 8 Protect PPs is a viable win condition path.

---

## 4. Speed Control

### Tailwind

- Doubles Speed for 4 turns
- Prankster Tailwind achieves Turn 1 priority setup
- When Tailwind expires, natural speed tiers immediately reassert — always know what your team's base speed tiers are so you can plan the transition

### Trick Room

- Reverses speed order for 5 turns
- -7 priority means the setter must survive the turn to successfully set it
- Under Trick Room: 0 Speed IV Pokémon become the fastest on the field; EV train accordingly

### Dynamic Speed Mid-Turn

The Talonflame/Gale Wings example: if Talonflame (+1 Flying priority via Gale Wings) is hit by a +2 Extreme Speed and its HP drops below 100% before it moves, its priority is immediately bumped down to the 0 bracket. Speed checks are recalculated at the moment of execution, not at the start of the turn.

### Meta Recommendation

Successful Reg M-B teams carry at least two forms of speed control (e.g., Tailwind + Icy Wind) to remain flexible when the primary control option is removed.

---

## 5. PP Reference (Reg M-B Fixed PP)

| Original PP | Fixed PP in Reg M-B |
|---|---|
| 5 PP (e.g., Draco Meteor) | 8 PP |
| 10 PP (e.g., Earthquake) | 12 PP |
| 15 PP (e.g., Flamethrower) | 24 PP |
| >15 PP (e.g., Night Slash) | 20 PP |

**Specifically capped at 8 PP:**
- Nihil Light (Mega Zygarde's signature — bypasses Fairy-type immunity; primary meta threat)
- Protect, Baneful Bunker, King's Shield, Obstruct, Spiky Shield
- Wide Guard
- Purify

---

## 6. Move Data: Reg M-B Modifications

All values below reflect Reg M-B rules. These override any base game values.

### Base Power

| Move | BP in Reg M-B | Notes |
|---|---|---|
| Astro Barrage | 110 | Spread: 82.5 effective (75% of 110) |
| Blood Moon | 130 | |
| Bolt Beak | 80 | Max boosted power: 160 |
| Fishious Rend | 80 | Max boosted power: 160 |
| Beak Blast | 120 | |
| Gear Grind | 120 | 60 per hit, 2 hits |
| Mountain Gale | 120 | |
| Hyper Drill | 120 | Bypasses Protect — premier anti-stall tool |
| Shadow Claw | 105 (via Sharpness) | High crit rate; Slicing category |
| Triple Dive | 105 | 35 per hit, 3 hits |
| Dragon Hammer | 100 | |
| First Impression | 100 | +2 priority |
| Revelation Dance | 100 | |
| Anchor Shot | 90 | |
| Apple Acid | 90 | |
| Fire Lash | 90 | |
| Grav Apple | 90 | Scales to 135 BP under Gravity |
| Spirit Shackle | 90 | |
| Side Shield Bash | 90 | Raises Wyrdeer viability |
| Bone Rush | 30/hit | 150 total (5 hits) |
| Infernal Parade | 65 | 130 vs. status-affected targets |

### Accuracy

| Move | Accuracy in Reg M-B |
|---|---|
| Make It Rain | 95% |
| Crabhammer | 95% |
| Syrup Bomb | 90% |
| Gear Grind | 90% |

### Secondary Effect Rates

| Move | Rate in Reg M-B |
|---|---|
| Dire Claw (Poison/Paralysis/Sleep) | 30% total (10% per status) |
| Iron Head (flinch) | 20% |
| Moonblast (SpAtk drop) | 10% |

### Salt Cure (Garganacl)

| Target Type | Chip per Turn |
|---|---|
| Standard | 6.25% max HP |
| Steel or Water | 12.5% max HP |

### Type Reclassifications

- Growth: now Grass-type
- Snap Trap: now Steel-type (grants STAB to Galarian Stunfisk)

### Toxic Thread

Now drops Speed by 2 stages (-2) in addition to inflicting poison. Treat as a speed control option.

---

## 7. Slicing Mechanic (Sharpness Expansion)

Sharpness provides a 1.5x damage multiplier to all Slicing-category moves. The following moves have been reclassified as Slicing in Reg M-B:

| Move | Base BP | Effective BP with Sharpness |
|---|---|---|
| Dragon Claw | 80 | 120 (equivalent to Outrage, no lock drawback) |
| Shadow Claw | 70 | 105 (high crit rate) |
| Night Slash | 70 | 105 (high crit rate) |
| Dire Claw | 50 | 75 (plus status proc) |

Previously classified Slicing moves (Psycho Cut, Razor Shell, etc.) retain their status.

---

## 8. Ability Modifications

| Ability | Reg M-B Behavior |
|---|---|
| Healer | 50% chance to cure ally status per turn (was 30%) |
| Unnerve | Known bug: entry-activation abilities (Hospitality, Drizzle) allow berry consumption despite Unnerve presence |

---

## 9. Status Conditions

| Status | Full Proc Rate | Duration Cap | Wake/Thaw Chance |
|---|---|---|---|
| Paralysis | 12.5% per turn | — | — |
| Sleep | — | 1-2 turns | 33% on turn 2 |
| Freeze | — | 3 turns max | 25% per turn |

---

## 10. Dominant Mega Evolutions

These are the primary Mega threats in the Reg M-B metagame. All calcs against common sets should reference these profiles.

### Mega Dragonite
- Role: Premier Tailwind setter, special attacker
- Key ability: Multiscale (takes 50% damage at full HP — always check if Multiscale is intact)
- Base speed: 100 (sits in a crowded bracket)
- Primary pressure: High-power special sets under Tailwind

### Mega Glimmora
- Role: Hazard-stacking pivot
- Key ability: Adaptability (1.5x STAB becomes 2.0x)
- Passive: Toxic Debris punishes physical contact moves
- Primary pressure: Adaptability-boosted Sludge Bomb threatens Fairy-types; hazard stacking chips the field

### Mega Aerodactyl
- Role: Fast Unnerve lead, Tailwind support
- Key ability: Unnerve (blocks berry consumption — note the known bug with entry abilities)
- Primary pressure: Blocks Berry-based recovery strategies from the moment it enters; fast Tailwind setter

### Archaludon (non-Mega but meta staple)
- Role: Rain archetype anchor
- Key abilities: Stamina (physical bulk), Electro Shot (immediate power under rain)
- Primary pressure: Stamina makes it increasingly difficult to KO with physical moves; Electro Shot fires instantly under Rain

---

## 11. Key Tactical Frameworks

### Fake Out Combinations

Fake Out is the most important tempo tool in Reg M-B. It guarantees a flinch on Turn 1, buying a free action for the partner.

**Top Fake Out users by speed (fastest to slowest):**
1. Weavile
2. Ludicolo (fastest in Rain via Swift Swim)
3. Hitmontop (Intimidate + Technician)
4. Incineroar

**Core Fake Out combinations:**

1. **Fake Out + Setup:** Flinch the primary threat while the partner sets Trick Room, Tailwind, or Weather. The most fundamental Turn 1 pattern.

2. **Fake Out + Encore:** Two-turn sequence. Turn 1: use Fake Out to force opponent into Protect. Turn 2: immediately Encore (Whimsicott/Infernape) to lock opponent into Protect, forcing a switch and losing field presence. Devastating against defensive leads.

3. **Fake Out + Substitute:** Flinch the opponent's primary offensive threat to allow the partner to safely set up a Substitute behind the protection window.

### Double Targeting

With Protect capped at 8 PP, pressuring both active Pokémon simultaneously is a core win condition. If a player is forced to Protect repeatedly, their PP drains rapidly. Spread moves (Rock Slide, Earthquake, Astro Barrage) plus a single-target move is the standard double-targeting pattern.

### Speed Control Transitions

When Tailwind or Trick Room expires, the team that wins the speed race goes to the side with naturally better base speed tiers. Always plan the post-field-effect state:
- Under Tailwind: your team is fast. What happens on turn 5?
- Under Trick Room: your slow mons are fastest. What happens on turn 6?

---

## 12. Meta Strategic Principles

1. **Natural speed tiering matters even under field effects.** When Tailwind or Trick Room expires, the naturally faster Pokémon immediately regains tempo. Always know your base speed tiers.

2. **Redundant speed control is required.** Carry at least two forms of speed control (e.g., Tailwind + Icy Wind). A single control option that gets removed leaves the team stranded.

3. **Pressure over stall.** Hyper Drill bypasses Protect. Protect is 8 PP. The meta rewards offensive momentum. Passive recovery strategies are significantly weakened in Reg M-B.

4. **Nihil Light is a tier-defining move.** Mega Zygarde's signature bypasses Fairy-type immunity — a type interaction that does not exist elsewhere. This move alone opens attack angles that no other mon provides. Account for it in threat assessments.

5. **Multiscale management.** Mega Dragonite's Multiscale halves damage at full HP. Chip damage (spread moves, weather, hazards) before attacking is the standard counterplay.

6. **Protect PP is a finite resource to exploit.** Forcing Protect usage is a valid strategy. If an opponent's Pokémon has used 6 of 8 Protect PP, double-targeting becomes extremely dangerous for them.
