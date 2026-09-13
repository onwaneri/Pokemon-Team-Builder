/**
 * POST /api/optimize-sp — find the minimum SP spread that passes a Pokémon's benchmarks.
 *
 * The model searches with the engine's calcDamage tool and finishes by calling
 * `returnOptimizedSP`; that spread is a claim, so the engine re-verifies every machine-checkable
 * benchmark and the SP budget before it is accepted. Rejections go back into the loop with the
 * failing detail so the model corrects itself. Interactive: own key or one free request.
 */
import { describeForms } from '@/lib/data/megas';
import { NextRequest, NextResponse } from 'next/server';
import { Type } from '@google/genai';
import { evaluateBenchmarks } from '@/lib/benchmarks/evaluate';
import { validateSp, type SpSpread } from '@/lib/calc/sp';
import type { Benchmark } from '@/lib/benchmarks/types';
import { calcDamageDeclaration, spSchema, runToolLoop } from '@/lib/ai/tools';
import { resolveAi, AiDenied, denialResponse } from '@/lib/ai/credential';
import { LlmError } from '@/lib/ai/llm';

export const runtime = 'nodejs';

const MAX_ROUNDS = 24;

interface BaseStats {
  hp: number; atk: number; def: number; spa: number; spd: number; spe: number;
}

function formatBenchmarks(benchmarks: Benchmark[]): string {
  if (!benchmarks.length) return 'None.';
  return benchmarks.map((b, i) => {
    const c = b.check;
    if (!c) return `${i + 1}. [CUSTOM] ${b.description} — status: ${b.status}`;
    if (c.kind === 'damage') {
      const o = c.opponent;
      const oppStr = [o.species, o.ability && `@ ${o.ability}`, o.item && `| ${o.item}`, o.nature && `| ${o.nature}`, o.sp?.spe != null && `| Spe SP ${o.sp.spe}`].filter(Boolean).join(' ');
      return `${i + 1}. [DAMAGE] ${b.description}
   Team role: ${c.teamRole} | Move: ${c.move} | Condition: ${c.condition}
   Opponent: ${oppStr}
   Status: ${b.status}`;
    }
    if (c.kind === 'speed') {
      const o = c.opponent;
      const oppStr = [o.species, o.nature && `| ${o.nature}`, o.sp?.spe != null && `| Spe SP ${o.sp.spe}`].filter(Boolean).join(' ');
      return `${i + 1}. [SPEED] ${b.description}
   Must be: ${c.comparator} than opponent | Opponent: ${oppStr}
   Status: ${b.status}`;
    }
    return `${i + 1}. ${b.description} — status: ${b.status}`;
  }).join('\n\n');
}

const returnOptimizedSPDecl = {
  name: 'returnOptimizedSP',
  description: 'Return the final optimized SP spread once all benchmarks are verified to pass.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sp: { ...spSchema, description: 'The minimum SP spread that passes all benchmarks. Omit stats at 0.' },
      reasoning: { type: Type.STRING, description: 'One sentence per benchmark explaining what the SP allocation achieves.' },
    },
    required: ['sp', 'reasoning'],
  },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { species, ability, item, nature, moves, baseStats, benchmarks } = body as {
    species: string;
    ability: string;
    item: string;
    nature: string;
    moves: string[];
    baseStats: BaseStats;
    benchmarks: Benchmark[];
  };

  let grant;
  try {
    grant = await resolveAi(req, { job: 'optimize', interactive: true });
  } catch (e) {
    if (e instanceof AiDenied) return denialResponse(e);
    throw e;
  }

  const system = `You are a Pokémon Champions SP optimizer. Find the MINIMUM SP spread that passes all benchmarks.

POKÉMON: ${species}
Ability: ${ability || '—'} | Item: ${item || '—'} | Nature: ${nature}
Moves: ${moves.filter(Boolean).join(' / ') || '(none)'}
Base stats: HP ${baseStats.hp} / Atk ${baseStats.atk} / Def ${baseStats.def} / SpA ${baseStats.spa} / SpD ${baseStats.spd} / Spe ${baseStats.spe}
${describeForms(species, item) ? `${describeForms(species, item)}\nThe SP spread is shared by both formes; optimize for the forme named above (species "${species}"), and calc with that exact species name.\n` : ''}
SP SYSTEM (Champions format, Level 50, all IVs = 31):
• Non-HP: floor(nature_mult × (base + SP + 20))   [nature_mult = 1.1 boosted / 0.9 hindered / 1.0 neutral]
• HP:     base_hp + SP + 20 + 60 + 1              [no nature multiplier]
• Per stat: 0–32 SP. Total budget: ≤ 66 SP.

BENCHMARKS TO SATISFY:
${formatBenchmarks(benchmarks)}

PROCESS:
1. For failing DAMAGE benchmarks: binary-search the SP that makes the condition pass using calcDamage.
   - ohko: min_damage > defender_max_hp
   - 2hko: min_damage × 2 > defender_max_hp  (use min roll, not average)
   - survives: max_damage ≤ defender_max_hp   (use max roll)
2. For failing SPEED benchmarks: compute floor(nature_mult × (base_spe + SP + 20)) and compare to opponent.
3. Start with 0 SP in all stats, find minimum per-stat values, then call returnOptimizedSP.

When in doubt, verify with calcDamage. Never guess damage.`;

  let accepted: { sp: SpSpread; reasoning: string; verified: Benchmark[] } | null = null;

  try {
    const { exhausted } = await runToolLoop({
      client: grant.client,
      system,
      messages: [{
        role: 'user',
        text: benchmarks.length === 0
          ? 'No benchmarks exist for this Pokémon. Return an empty SP spread (all zeroes, no stats needed).'
          : 'Optimize the SP spread to pass all benchmarks with minimum total SP. Use calcDamage to verify damage benchmarks. Then call returnOptimizedSP.',
      }],
      declarations: [calcDamageDeclaration, returnOptimizedSPDecl],
      maxRounds: MAX_ROUNDS,
      stopWhen: () => accepted !== null,
      dispatch: async (name, rawArgs) => {
        if (name !== 'returnOptimizedSP') return { error: `Unknown tool: ${name}` };
        const args = rawArgs as { sp?: Record<string, number>; reasoning?: string };
        const sp: SpSpread = {};
        for (const [k, v] of Object.entries(args.sp ?? {})) {
          const n = Math.max(0, Math.min(32, Math.round(Number(v) || 0)));
          if (n > 0) sp[k as keyof SpSpread] = n;
        }
        const budget = validateSp(sp);
        const verified = evaluateBenchmarks({ species, ability, item, nature, sp }, benchmarks);
        const failing = verified.filter((b) => b.check && b.status === 'failing');
        if (budget.ok && failing.length === 0) {
          accepted = { sp, reasoning: args.reasoning ?? '', verified };
          return { status: 'ok', message: 'Spread verified by the engine.' };
        }
        const rejection = [
          ...(budget.ok ? [] : budget.errors),
          ...failing.map((b) => `"${b.description}" still failing: ${b.detail ?? 'engine check failed'}`),
        ];
        return {
          error: `Engine re-verification REJECTED this spread:\n- ${rejection.join('\n- ')}\nAdjust the SP allocation, verify with calcDamage, then call returnOptimizedSP again.`,
        };
      },
    });

    if (!accepted) {
      return NextResponse.json(
        { error: exhausted ? 'Optimization did not converge after too many rounds.' : 'Model stopped without returning a spread. Try adding benchmarks first.' },
        { status: 500, headers: grant.headers },
      );
    }
    const { sp, reasoning, verified } = accepted as { sp: SpSpread; reasoning: string; verified: Benchmark[] };
    return NextResponse.json({
      sp,
      reasoning,
      verification: verified.filter((b) => b.check).map((b) => ({ description: b.description, status: b.status, detail: b.detail })),
    }, { headers: grant.headers });
  } catch (e) {
    await grant.refund();
    const status = e instanceof LlmError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message ?? 'Optimization failed.' }, { status, headers: grant.headers });
  }
}
