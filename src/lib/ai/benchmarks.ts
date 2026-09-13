/**
 * Infer a one-line competitive role for each team member (structured JSON output on whatever
 * provider the request is entitled to; no client → blank roles).
 * Benchmarks are no longer auto-generated at
import — users add them manually or via chat.
 */
import { Type } from '@google/genai';
import { formsJson } from '@/lib/data/megas';
import type { LlmClient } from '@/lib/ai/llm';
import { generateJson } from '@/lib/ai/tools';
import { championsMeta } from '@/lib/data/meta';
import type { ParsedMember } from '@/lib/showdown/import';
import { DEFAULT_RULESET, type RulesetId } from '@/lib/rulesets';

export interface InferredMember {
  slot: number;
  role: string;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    members: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slot: { type: Type.NUMBER },
          role: {
            type: Type.STRING,
            description:
              'One concise sentence describing the role this Pokémon plays on the team.',
          },
        },
        required: ['slot', 'role'],
      },
    },
  },
  required: ['members'],
};

const SYSTEM = `You are a Pokémon Champions (VGC doubles) team analyst. For each Pokémon in the team,
write exactly one concise sentence describing its competitive role (e.g. "Speed-control lead that sets
Tailwind and threatens opposing Fairy-types with Poison coverage."). Champions: Level 50, IVs 31, SP
system. NO Terastallization. Use exact engine species names.`;

export async function inferTeam(
  members: (ParsedMember & { computedStats: Record<string, number> })[],
  ruleset: RulesetId = DEFAULT_RULESET,
  client?: LlmClient | null,
): Promise<InferredMember[]> {
  if (!client) return members.map((m) => ({ slot: m.slot, role: '' }));

  const teamJson = members.map((m) => ({
    slot: m.slot,
    species: m.species,
    item: m.item,
    ability: m.ability,
    nature: m.nature,
    sp: m.sp,
    moves: m.moves,
    ...(formsJson(m.species, m.item) ? { megaForms: formsJson(m.species, m.item) } : {}),
  }));

  const prompt = `${championsMeta(ruleset)}\n\nTeam:\n${JSON.stringify(teamJson, null, 1)}\n\nReturn a one-sentence role for each of the ${members.length} Pokémon.`;

  const parsed = await generateJson<{ members?: InferredMember[] }>(client, { system: SYSTEM, prompt, schema: responseSchema });
  return parsed?.members ?? members.map((m) => ({ slot: m.slot, role: '' }));
}
