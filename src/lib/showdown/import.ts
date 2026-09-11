/**
 * Parse a Showdown-style team paste into Champions sets.
 *
 * Champions trains with Stat Points (SP, 0–32, ≤66 total), not EVs/IVs. Pastes may carry SP directly
 * (small values, often labelled "SPs:") or legacy EVs (values up to 252). We detect which: if the line
 * is labelled EVs or any value exceeds 32, we convert EV→SP via SP = round(EV / 8) (1 SP ≈ 8 EVs),
 * clamped to 0–32; otherwise we treat the numbers as SP directly. IVs are ignored (always 31).
 */
import { validateLegality, defaultAbility, type LegalityIssue } from '@/lib/data/champions';
import { SP_PER_STAT_MAX, STAT_ORDER, type SpSpread, type Stat } from '@/lib/calc/sp';
import { DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';

export interface ParsedMember {
  slot: number;
  nickname: string | null;
  species: string;
  item?: string;
  ability?: string;
  nature: string;
  sp: SpSpread;
  moves: string[];
}

export interface ParsedTeam {
  members: ParsedMember[];
  issues: LegalityIssue[];
}

function parseFirstLine(line: string): { nickname: string | null; species: string; item?: string } {
  const [namePart, ...itemParts] = line.split(' @ ');
  const item = itemParts.length ? itemParts.join(' @ ').trim() : undefined;

  // Collect parenthesized groups; a single M/F/N group is gender, anything else is the species.
  const groups = [...namePart.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
  const speciesGroup = groups.find((g) => !/^[MFN]$/.test(g));
  const lead = namePart.replace(/\([^)]*\)/g, '').trim();

  if (speciesGroup) {
    return { nickname: lead || null, species: speciesGroup, item };
  }
  return { nickname: null, species: lead, item };
}

function parseStatLine(line: string): { sp: SpSpread; wasEv: boolean } {
  const body = line.replace(/^[^:]*:/, '');
  const raw: Partial<Record<Stat, number>> = {};
  for (const part of body.split('/')) {
    const m = part.trim().match(/^(\d+)\s+([A-Za-z]+)$/);
    if (!m) continue;
    const stat = STAT_ORDER.find((s) => s === m[2].toLowerCase());
    if (stat) raw[stat] = Number(m[1]);
  }
  const values = Object.values(raw);
  // Treat as EVs only if a value exceeds the SP cap (32). The label alone is not enough — Champions
  // pastes often use "EVs:" with SP values (≤32), and dividing those by 8 would corrupt them.
  const looksLikeEv = values.some((v) => v > SP_PER_STAT_MAX);
  const sp: SpSpread = {};
  for (const [stat, v] of Object.entries(raw) as [Stat, number][]) {
    const points = looksLikeEv ? Math.round(v / 8) : v;
    sp[stat] = Math.min(SP_PER_STAT_MAX, Math.max(0, points));
  }
  return { sp, wasEv: looksLikeEv };
}

function parseBlock(block: string, slot: number): ParsedMember | null {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const head = parseFirstLine(lines[0]);
  if (!head.species) return null;

  const member: ParsedMember = {
    slot,
    nickname: head.nickname,
    species: head.species,
    item: head.item,
    ability: undefined,
    nature: 'Hardy',
    sp: {},
    moves: [],
  };

  for (const line of lines.slice(1)) {
    if (/^ability:/i.test(line)) member.ability = line.replace(/^ability:/i, '').trim();
    else if (/nature$/i.test(line)) member.nature = line.replace(/nature$/i, '').trim();
    else if (/^(evs|sps):/i.test(line)) member.sp = parseStatLine(line).sp;
    else if (/^ivs:/i.test(line)) {
      /* ignored — Champions IVs are fixed at 31 */
    } else if (/^level:/i.test(line)) {
      /* always 50 */
    } else if (line.startsWith('-')) {
      const mv = line.replace(/^-\s*/, '').trim();
      if (mv && member.moves.length < 4) member.moves.push(mv);
    }
  }

  if (!member.ability) member.ability = defaultAbility(member.species);
  return member;
}

export function parseTeam(paste: string, ruleset: RulesetId = DEFAULT_RULESET): ParsedTeam {
  const blocks = paste
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const members: ParsedMember[] = [];
  for (const block of blocks) {
    const m = parseBlock(block, members.length + 1);
    if (m) members.push(m);
  }

  const issues: LegalityIssue[] = [];
  for (const m of members) {
    issues.push(
      ...validateLegality({ species: m.species, item: m.item, ability: m.ability, moves: m.moves }, ruleset).map((iss) => ({
        ...iss,
        message: `Slot ${m.slot} (${m.species}): ${iss.message}`,
      })),
    );
  }

  return { members, issues };
}
