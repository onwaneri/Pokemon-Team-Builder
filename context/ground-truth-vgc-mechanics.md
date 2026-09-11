# Ground Truth: Pokémon VGC Doubles Mechanics

This document is the authoritative reference for all VGC doubles battle mechanics as they apply to the Champions era. It is used as Layer 1 immutable context in the VGC Champions Tool. Nothing in this document is inferred — it is ground truth that the calc engine and Claude both treat as fixed law.

---

## 1. Format Overview

VGC is a 2v2 double battle format. Both players bring 4 Pokémon from a team of 6 and select which 4 to use at the start of each match. Two Pokémon are active on each side at all times.

**Draw Rule (Champions Era):** If the battle timer expires and both players have an equal number of remaining Pokémon, the match is declared a Draw. The legacy HP percentage tiebreaker has been removed entirely. This disincentivizes passive stall — securing KOs before the clock runs out is a requirement, not a suggestion.

---

## 2. Turn Order and Dynamic Speed

Speed is a fluid resource in modern VGC. Turn order is recalculated immediately mid-turn after any speed modification.

**Dynamic Speed:** If a Pokémon's speed is altered via Tailwind, Icy Wind, an ability activation (e.g., Swift Swim), or any other modifier, speed brackets update instantly. A partner whose speed doubles from a Prankster Tailwind can immediately jump ahead of opponents in the same turn before any offensive moves resolve.

**Speed Ties:** When two Pokémon share an identical Speed stat, the game randomly determines who moves first (50/50). At the competitive level, EV train to hit speed tiers one point above common threats to eliminate this variance. Claude must always flag speed ties — never assume the outcome.

### Action Sequence (Within a Turn)

Before move execution, the game processes in this fixed order:

1. Switching: Pokémon are withdrawn and sent in
2. Abilities: Entry-activation abilities trigger (Intimidate, Drizzle, Hospitality, etc.)
3. Move execution: Ordered by priority bracket, then speed within each bracket

**Speed Scouting:** By watching the order in which entry abilities activate, you can deduce the exact speed relationship between your Pokémon and the opponent's before a single move is clicked. If your Intimidate triggers after theirs, you are the slower Pokémon.

---

## 3. Priority Bracket System

Priority overrides Speed entirely. Higher bracket moves always execute before lower bracket moves. Within the same bracket, Speed determines order.

| Bracket | Key Moves | Strategic Context |
|---|---|---|
| +5 | Helping Hand | Boosts partner's damage; essential for securing spread KOs |
| +4 | Protect, Detect, Wide Guard, Spiky Shield, Baneful Bunker, King's Shield, Obstruct | Defensive stalling and positioning |
| +3 | Fake Out | Guarantees flinch; Turn 1 only (Champions era rule) |
| +2 | Extreme Speed, Follow Me, Rage Powder, First Impression (100 BP) | Redirection; strongest non-Fake Out priority |
| +1 | Aqua Jet, Bullet Punch, Mach Punch, Sucker Punch | Cleaning tools; Sucker Punch fails if target uses non-damaging move or moves first |
| 0 | All standard moves | Default bracket for offensive pressure |
| -7 | Trick Room | Always moves last; ensures counterplay opportunity |

**Sucker Punch rule:** Fails if the target uses a non-damaging move or moves first within the same priority bracket.

**Fake Out rule (Champions era):** Cannot be selected after the first turn the user is on the field. This prevents accidental misclicks in high-pressure Best-of-3 sets.

---

## 4. Speed Control Archetypes

### Primary Speed Control

| | Tailwind | Trick Room |
|---|---|---|
| Mechanic | Doubles Speed for 4 turns | Reverses speed order for 5 turns |
| Philosophy | Offensive pressure for fast/frail teams | Counter-meta for bulky slow attackers |
| Setup | Prankster Tailwind allows Turn 1 priority setup | -7 priority forces the setter to survive the turn |
| Best users | Whimsicott, Talonflame | Slow bulky setters (Cresselia, etc.) |

### Supplementary Speed Control

- **Spread speed drops:** Icy Wind and Electroweb hit both opponents simultaneously, dropping the speed tier of the entire opposing field in one move
- **Syrup Bomb:** Drops the target's speed at the end of each turn for 3 turns
- **Toxic Thread:** Drops the target's Speed by 2 stages (-2) — a legitimate speed control option
- **Weather/ability doublers:** Swift Swim (Rain), Chlorophyll (Sun), Sand Rush (Sand), Slush Rush (Snow)
- **Turn order manipulation:** Quash forces a target to move last in its bracket; After You pulls a partner to move immediately after the user

---

## 5. Spread Move Damage

**Base rule:** Moves that target multiple slots deal 75% of their base damage to each target.

**Targeting vs. Hitting:** The 25% reduction is determined by the slots targeted at the start of the move, not whether the attack successfully lands. This means:
- If one target uses Protect, the other target still only takes 75% damage
- If one target is immune (e.g., a Flying-type vs. Earthquake), the remaining target still takes 75%
- If one target is in a semi-invulnerable state (Dig, Fly), the remaining target still takes 75%

**Lone Survivor Exception:** If one target faints before the spread move resolves (due to a faster teammate's attack or prior chip damage), the move reverts to 100% damage against the remaining target.

---

## 6. Redirection

**Move redirection:** Follow Me and Rage Powder (+2 priority) force all single-target attacks to hit the user instead of their intended target.

**Type redirection (abilities):**
- Lightningrod: Draws all Electric-type moves to the bearer, granting immunity and a Special Attack boost
- Storm Drain: Draws all Water-type moves to the bearer, granting immunity and a Special Attack boost

These abilities protect their partner from an entire type of move, not just redirected attacks.

---

## 7. Field Effects

### Terrains (affect grounded Pokémon only)

| Terrain | Damage Boost | Other Effects |
|---|---|---|
| Electric | +30% Electric | Prevents sleep; enables Rising Voltage (doubles power) |
| Grassy | +30% Grass | 1/16 HP recovery per turn; halves Earthquake and Bulldoze damage |
| Psychic | +30% Psychic | Blocks all increased priority moves including Prankster status; enables Expanding Force (spread) |
| Misty | Halves Dragon damage | Prevents non-volatile status (Burn, Poison, Paralysis) and confusion |

### Weather

| Weather | Damage Modifier | Other Effects |
|---|---|---|
| Sun | +50% Fire, -50% Water | Prevents freeze; instant Solar Beam/Solar Blade |
| Rain | +50% Water, -50% Fire | Thunder and Hurricane bypass accuracy checks |
| Sandstorm | None | 1/16 chip per turn; +50% Special Defense for Rock-types |
| Snow | None (removes chip) | Enables Aurora Veil; Blizzard has perfect accuracy |

### Screens (Doubles)

In VGC doubles, Reflect, Light Screen, and Aurora Veil provide a **33% damage reduction** (not 50% as in singles). Holding Light Clay extends screen duration to 8 turns.

---

## 8. The Protect Metagame

Protect is the most important move in VGC. Uses include:
- Stalling out field effects (weather, terrain, Tailwind turns)
- Punishing double-targeting by forcing the opponent to waste moves
- Scouting — observing opponent behavior while safe

**Champions era PP cap:** All Protect variants (Protect, Detect, Spiky Shield, Baneful Bunker, King's Shield, Obstruct, Wide Guard) are capped at 8 PP. Disciplined PP management is required in long-form matches. If an opponent burns all 8 PP on Protect, the game state becomes untenable for the defender.

---

## 9. Status Conditions (Champions Era Rebalancing)

The Champions era has significantly reduced RNG variance from status conditions.

| Status | Old Behavior | New Behavior |
|---|---|---|
| Paralysis (full) | 25% chance to lose a turn | 12.5% chance to lose a turn |
| Sleep | Variable duration | Capped at 1-2 turns; 33% chance to wake on turn 2 |
| Freeze | Variable duration, 20% thaw/turn | Max 3 turns; 25% thaw chance per turn |

---

## 10. PP System (Champions Era Fixed PP)

The legacy PP Max variable system has been replaced with a fixed category-based structure.

| Original PP | New Fixed PP |
|---|---|
| 5 PP (e.g., Draco Meteor) | 8 PP |
| 10 PP (e.g., Earthquake) | 12 PP |
| 15 PP (e.g., Flamethrower, Thunderbolt) | 24 PP |
| >15 PP (e.g., Night Slash) | 20 PP |

**High-impact 8 PP caps:** The following moves are specifically capped at 8 PP to combat passive stalling:
- All Protect variants (Protect, Detect, Baneful Bunker, King's Shield, Obstruct, Spiky Shield, Wide Guard)
- Purify

---

## 11. Secondary Effects After User Fainting

Secondary effects from the following moves now trigger successfully even if the user faints from contact damage (Rough Skin, Iron Barbs, Rocky Helmet) during the move animation:
- Knock Off (item removal)
- Rapid Spin
- Mortal Spin
- Ceaseless Edge (hazard placement)

This makes item removal and hazard management significantly more reliable.

---

## 12. Ability Interactions

**Unseen Fist (Urshifu):** Bypassing Protect now deals only 25% damage instead of 100%. Major nerf to Urshifu archetypes.

**Healer:** Activation rate to cure an ally's status condition buffed from 30% to 50%.

**Unnerve (known bug):** Entry-activation abilities (Hospitality from Sinistcha, Drizzle from Pelipper) allow Pokémon to consume berries even in the presence of an Unnerve user. Account for this in planning.

**Sharpness:** Provides a 50% damage multiplier to all moves classified as Slicing moves. The following moves have been reclassified as Slicing in the Champions era:
- Dire Claw (newly classified)
- Dragon Claw (newly classified): effective 120 BP with Sharpness
- Shadow Claw (newly classified): effective 105 BP with Sharpness, high crit rate
- Night Slash (newly classified): effective 105 BP with Sharpness

---

## 13. Move Data Reference (Champions Era Modifications)

### Base Power Changes

| Move | Old BP | New BP | Notes |
|---|---|---|---|
| Astro Barrage | 120 | 110 | Spread: 82.5 effective |
| Blood Moon | 140 | 130 | |
| Bolt Beak | 85 | 80 | Max boosted: 160 |
| Fishious Rend | 85 | 80 | Max boosted: 160 |
| Beak Blast | — | 120 | |
| Gear Grind | — | 120 | 60 per hit |
| Mountain Gale | — | 120 | |
| Hyper Drill | — | 120 | Breaks through Protect |
| Shadow Claw | — | 105 (Slicing) | Via Sharpness |
| Triple Dive | — | 105 | 35 per hit |
| Dragon Hammer | — | 100 | |
| First Impression | — | 100 | +2 priority |
| Revelation Dance | — | 100 | |
| Anchor Shot | — | 90 | |
| Apple Acid | — | 90 | |
| Fire Lash | — | 90 | |
| Grav Apple | — | 90 (135 in Gravity) | |
| Spirit Shackle | — | 90 | |
| Side Shield Bash | — | 90 | |
| Bone Rush | — | 30/hit | 150 total |
| Infernal Parade | — | 65 | 130 vs. status targets |

### Accuracy Changes

| Move | Old Accuracy | New Accuracy |
|---|---|---|
| Make It Rain | 100% | 95% |
| Crabhammer | — | 95% |
| Syrup Bomb | — | 90% |
| Gear Grind | — | 90% |

### Secondary Effect Rate Changes

| Move | Old Rate | New Rate |
|---|---|---|
| Dire Claw (status proc) | 50% total | 30% total (10% per status) |
| Iron Head (flinch) | 30% | 20% |
| Moonblast (SpAtk drop) | 30% | 10% |

### Salt Cure (Garganacl)

| Target | Old Chip | New Chip |
|---|---|---|
| Standard targets | 12.5% per turn | 6.25% per turn |
| Steel/Water targets | 25% per turn | 12.5% per turn |

### Type Reclassifications

- Growth: reclassified as Grass-type
- Snap Trap: reclassified as Steel-type (grants STAB to Galarian Stunfisk)

### Toxic Thread

Now lowers the target's Speed by 2 stages (-2) in addition to poisoning, making it a legitimate speed control option.

---

## 14. Damage Formula

```
Damage = floor(floor(floor(2 × Level / 5 + 2) × BasePower × Atk / Def / 50) + 2)
         × Targets × Weather × Critical × Random × STAB × Type × Burn × Other
```

- **Targets modifier:** 0.75 for spread moves (see Section 5)
- **Weather modifier:** 1.5 for boosted type, 0.5 for weakened type
- **Critical hit:** 1.5x damage; ignores negative attacker stat stages and positive defender stat stages
- **Random:** One of 16 values from 85/100 to 100/100 (the "roll")
- **STAB:** 1.5x (or 2.0x for Adaptability)
- **Burn:** 0.5x on physical moves from a burned attacker
- **Screens (doubles):** 0.67x (33% reduction, not 50%)

---

## 15. Stat Calculation Formula

```typescript
// Non-HP stats
stat = floor((floor((2 × base + iv + floor(ev / 4)) × level / 100) + 5) × nature)

// HP stat
hp = floor((2 × base + iv + floor(ev / 4)) × level / 100) + level + 10

// Nature modifier: 1.1 for boosted, 0.9 for reduced, 1.0 for neutral
```

- Level is always 50 in VGC
- Max EVs per stat: 252
- Total EV budget: 510
- Default IVs: 31 in all stats unless specified (e.g., 0 IV Speed for Trick Room)
