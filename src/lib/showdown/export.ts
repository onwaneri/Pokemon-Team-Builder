/**
 * Export a Champions team back to Showdown-style paste format (SP-native).
 *
 * The output is designed to round-trip through parseTeam() in import.ts:
 *   parseTeam(exportTeamPaste(team)) reproduces species/item/ability/nature/sp/moves/nickname
 *   for every filled slot without loss.
 *
 * Format rules (per spec):
 *   - First line: "Nickname (Species) @ Item" when nickname is set and item present.
 *     "Nickname (Species)" when nickname set but no item.
 *     "Species @ Item" when no nickname but item present.
 *     "Species" when neither.
 *   - "Ability: X" line only when ability is set and non-empty.
 *   - "Level: 50" always (Champions is always Level 50).
 *   - "EVs: X HP / Y Atk / …" listing only stats > 0, in canonical order HP/Atk/Def/SpA/SpD/Spe.
 *     The values are Stat Points (0–32) — that is what Showdown's Champions teambuilder expects on
 *     its EVs line. Line omitted entirely when all SPs are 0.
 *   - "X Nature" always (explicit beats implicit — never omit the nature line).
 *   - "- Move" lines for each non-empty move string.
 *   - Blank line between mons; null slots are skipped.
 */
import type { TeamMon } from '@/lib/benchmarks/types';
import { STAT_ORDER, STAT_LABEL, isCompleteNature } from '@/lib/calc/sp';

function exportMon(mon: TeamMon): string {
  const lines: string[] = [];

  // ── First line: name/species/item ──────────────────────────────────────────
  const hasNickname = mon.nickname && mon.nickname.trim().length > 0;
  const hasItem = mon.item && mon.item.trim().length > 0;

  let firstLine: string;
  if (hasNickname) {
    firstLine = `${mon.nickname} (${mon.species})`;
  } else {
    firstLine = mon.species;
  }
  if (hasItem) {
    firstLine += ` @ ${mon.item}`;
  }
  lines.push(firstLine);

  // ── Ability ────────────────────────────────────────────────────────────────
  if (mon.ability && mon.ability.trim().length > 0) {
    lines.push(`Ability: ${mon.ability}`);
  }

  // ── Level (always 50) ─────────────────────────────────────────────────────
  lines.push('Level: 50');

  // ── Stat line ─────────────────────────────────────────────────────────────
  // Showdown's Champions formats read Stat Points straight off the "EVs:" line (0–32 per stat; see
  // sim/TEAMS.md: "EVs represent stat points in Pokémon Champions"). Emitting "SPs:" made Showdown
  // silently drop the spread, so the label is EVs while the numbers stay SP. parseTeam() accepts
  // either label and treats values ≤32 as SP, so round-tripping is unchanged.
  const spParts: string[] = [];
  for (const stat of STAT_ORDER) {
    const val = mon.sp[stat] ?? 0;
    if (val > 0) {
      spParts.push(`${val} ${STAT_LABEL[stat]}`);
    }
  }
  if (spParts.length > 0) {
    lines.push(`EVs: ${spParts.join(' / ')}`);
  }

  // ── Nature (always present) ────────────────────────────────────────────────
  lines.push(`${isCompleteNature(mon.nature) ? mon.nature : 'Hardy'} Nature`);

  // ── Moves ─────────────────────────────────────────────────────────────────
  for (const move of mon.moves) {
    if (move && move.trim().length > 0) {
      lines.push(`- ${move}`);
    }
  }

  return lines.join('\n');
}

/**
 * Serialize a 6-slot team to a Showdown-compatible SP-native paste.
 * Null slots are skipped. Mons are separated by a single blank line.
 */
export function exportTeamPaste(team: (TeamMon | null)[]): string {
  const blocks = team.filter((mon): mon is TeamMon => mon !== null).map(exportMon);
  return blocks.join('\n\n');
}
