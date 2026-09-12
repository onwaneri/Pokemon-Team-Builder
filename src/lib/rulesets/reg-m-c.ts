/**
 * Regulation M-C — ranked season September 9 – December 2, 2026.
 * Source: https://www.serebii.net/pokemonchampions/rankedbattle/regulationm-c.shtml
 *
 * Delta over Reg M-B: 36 newly usable Pokémon (31 dex names — Toxtricity and Indeedee count both
 * formes) and 12 newly legal items, plus the Mega Stones the new Megas need. Pikalytics now publishes M-C
 * rankings, per-species usage, and teammate percentages, so M-C is the default ruleset. It still
 * has no spread data (that FAQ answers "No EV spread or nature data available"), so M-B stays the
 * usage fallback and fetchUsage borrows the spread from it per species, labelled via
 * topSpreadSource. M-B in turn serves no teammate percentages.
 */
import type { Ruleset } from './types';

export const REG_M_C: Ruleset = {
  id: 'reg-m-c',
  label: 'Regulation M-C',
  short: 'Reg M-C',
  dates: 'September 9 – December 2, 2026',
  pikalyticsFormats: ['gen9championsvgc2026regmc', 'gen9championsvgc2026regmb'],
  addedSpecies: [
    'Wigglytuff',
    'Persian-Alola',
    'Farfetch’d',
    'Mr. Mime',
    'Swalot',
    'Absol-Mega-Z',
    'Salamence',
    'Salamence-Mega',
    'Garchomp-Mega-Z',
    'Lucario-Mega-Z',
    'Gogoat',
    'Golisopod',
    'Golisopod-Mega',
    'Rillaboom',
    'Cinderace',
    'Inteleon',
    'Thievul',
    'Toxtricity',
    'Toxtricity-Low-Key',
    'Grapploct',
    'Perrserker',
    'Sirfetch’d',
    'Pincurchin',
    'Indeedee',
    'Indeedee-F',
    'Pawmot',
    'Arboliva',
    'Squawkabilly',
    'Mabosstiff',
    'Baxcalibur',
    'Baxcalibur-Mega',
  ],
  bannedSpecies: [],
  addedItems: [
    // Newly added held items.
    'Leek',
    'Rocky Helmet',
    'Air Balloon',
    'Red Card',
    'Binding Band',
    'Eject Button',
    'Normal Gem',
    'Terrain Extender',
    'Electric Seed',
    'Psychic Seed',
    'Misty Seed',
    'Grassy Seed',
    // Mega Stones for the newly usable Megas.
    'Absolite Z',
    'Salamencite',
    'Garchompite Z',
    'Lucarionite Z',
    'Golisopite',
    'Baxcalibrite',
  ],
  bannedItems: [],
  // Signature moves of the additions that the gen-0 move table does not carry.
  addedMoves: [
    'Pyro Ball',
    'Drum Beating',
    'Overdrive',
    'Octolock',
    'Meteor Assault',
    'Glaive Rush',
    'Double Shock',
    'Revival Blessing',
    'Court Change',
  ],
  bannedMoves: [],
  notes: `Regulation M-C (ranked season September 9 – December 2, 2026) adds 36 Pokémon to the Reg M-B pool:
Wigglytuff, Persian-Alola, Farfetch'd, Mr. Mime, Swalot, Absol-Mega-Z, Salamence and Salamence-Mega, Garchomp-Mega-Z,
Lucario-Mega-Z, Gogoat, Golisopod and Golisopod-Mega, Rillaboom, Cinderace, Inteleon, Thievul, Toxtricity (both forms),
Grapploct, Perrserker, Sirfetch'd, Pincurchin, Indeedee (both forms), Pawmot, Arboliva, Squawkabilly, Mabosstiff,
Baxcalibur and Baxcalibur-Mega. The "-Z" Megas are new Champions formes with their own stats and typing (e.g.
Absol-Mega-Z is Dark/Ghost) — always use the exact hyphenated names.
Newly legal items: Leek, Rocky Helmet (chip on contact), Air Balloon (Ground immunity until hit), Red Card, Binding Band,
Eject Button, Normal Gem, Terrain Extender, and the four terrain Seeds (+1 Def or SpD when the matching terrain is up,
which pairs with the new terrain setters Rillaboom / Grassy Surge, Indeedee / Psychic Surge, Pincurchin / Electric Surge).
Rocky Helmet punishes contact-heavy attackers and Fake Out users; Air Balloon changes Earthquake spam math.`,
};
