/**
 * Convert a natural-language benchmark description into a structured BenchmarkCheck via Gemini.
 * Called both from the manual add flow (API route) and by the AI proposeBenchmark tool.
 */
import { describeForms } from '@/lib/data/megas';
import { Type } from '@google/genai';
import type { LlmClient } from '@/lib/ai/llm';
import { generateJson } from '@/lib/ai/tools';
import type { BenchmarkCheck } from './types';


const SYSTEM = `You are a Pokémon Champions (VGC doubles, gen 0 / "Champions" format) benchmark parser.

Given a natural-language benchmark description, return a structured JSON object describing the
mechanical check to run. The check must be one of:

1. damage check — does the team Pokémon OHKO / 2HKO / 3HKO / survive a hit?
   Fields: kind="damage", teamRole ("attacker"|"defender"), move, opponent.species,
           optionally opponent.ability/item/nature/sp, condition ("ohko"|"2hko"|"3hko"|"survives"),
           optionally weather, terrain.

2. speed check — does the team Pokémon move before/after a threat?
   Fields: kind="speed", comparator ("faster"|"slower"), opponent.species,
           optionally opponent.nature/sp.spe, tailwind ("self"|"opponent"|"none"), trickRoom (bool).

Opponent stat investment (Champions SP system: 0–32 per stat, ≤66 total):
- "max HP X" → opponent.sp.hp = 32. "max Speed X" → opponent.sp.spe = 32 (add a +Spe nature like
  Timid/Jolly only if the description says so, e.g. "Jolly max Speed").
- Descriptions with EV numbers (0–252 scale) are legacy language: convert SP = round(EV / 8),
  capped at 32 per stat.
- If the description states no investment, OMIT sp entirely — the evaluator will surface its
  0-SP assumption to the user. Never invent an investment that was not stated.

If the description cannot be mapped to either check (e.g. "pivot with U-turn" is a strategy note,
not a mechanical check), return { kind: "unresolvable" }.

Return only valid JSON matching the schema. Do not include commentary.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    kind: {
      type: Type.STRING,
      enum: ['damage', 'speed', 'unresolvable'],
    },
    teamRole: { type: Type.STRING, enum: ['attacker', 'defender'] },
    move: { type: Type.STRING },
    opponent: {
      type: Type.OBJECT,
      properties: {
        species: { type: Type.STRING },
        ability: { type: Type.STRING },
        item: { type: Type.STRING },
        nature: { type: Type.STRING },
        sp: {
          type: Type.OBJECT,
          description: 'Opponent Stat Points (0–32 each), only for investment the description states.',
          properties: {
            hp: { type: Type.NUMBER },
            atk: { type: Type.NUMBER },
            def: { type: Type.NUMBER },
            spa: { type: Type.NUMBER },
            spd: { type: Type.NUMBER },
            spe: { type: Type.NUMBER },
          },
        },
      },
    },
    condition: { type: Type.STRING, enum: ['ohko', '2hko', '3hko', 'survives'] },
    weather: { type: Type.STRING },
    terrain: { type: Type.STRING },
    comparator: { type: Type.STRING, enum: ['faster', 'slower'] },
    tailwind: { type: Type.STRING, enum: ['self', 'opponent', 'none'] },
    trickRoom: { type: Type.BOOLEAN },
  },
  required: ['kind'],
};

export async function parseBenchmarkDescription(
  description: string,
  monSpecies: string,
  client: LlmClient | null | undefined,
  monItem?: string,
): Promise<BenchmarkCheck | null> {
  if (!client) return null;
  const forms = describeForms(monSpecies, monItem);
  const prompt = `Team Pokémon: ${monSpecies}${monItem ? ` @ ${monItem}` : ''}${forms ? `\n${forms}` : ''}\nBenchmark: "${description}"\n\nParse the benchmark above.`;

  try {
    const parsed = await generateJson<Record<string, unknown>>(client, { system: SYSTEM, prompt, schema: responseSchema });
    if (!parsed || parsed.kind === 'unresolvable') return null;
    // Clamp any model-supplied opponent SP to the legal Champions range before it reaches the engine.
    const opponent = parsed.opponent as { sp?: Record<string, number> } | undefined;
    if (opponent?.sp) {
      for (const [stat, v] of Object.entries(opponent.sp)) {
        opponent.sp[stat] = Math.max(0, Math.min(32, Math.round(Number(v) || 0)));
      }
    }
    return parsed as unknown as BenchmarkCheck;
  } catch {
    return null;
  }
}
