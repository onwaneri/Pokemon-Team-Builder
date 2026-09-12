import { NextResponse } from 'next/server';
import { evaluateBenchmarks, type EvalMon } from '@/lib/benchmarks/evaluate';
import { parseBenchmarkDescription } from '@/lib/benchmarks/parse';
import type { Benchmark } from '@/lib/benchmarks/types';
import { resolveAi } from '@/lib/ai/credential';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { mon?: EvalMon; benchmarks?: Benchmark[]; species?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body.mon || !body.benchmarks) {
    return NextResponse.json({ error: 'mon and benchmarks are required.' }, { status: 400 });
  }

  const species = body.species ?? body.mon.species;

  // Re-parsing benchmarks that still lack a structured check is ambient work: it only happens on
  // the visitor's own key. Without one they stay "needs review", which the evaluator reports.
  const grant = await resolveAi(req, { job: 'eval', interactive: false });
  const withChecks: Benchmark[] = await Promise.all(
    body.benchmarks.map(async (b) => {
      if (b.check || !grant) return b;
      const check = await parseBenchmarkDescription(b.description, species, grant.client).catch(() => null);
      return check ? { ...b, check } : b;
    }),
  );

  try {
    const benchmarks = evaluateBenchmarks(body.mon, withChecks);
    return NextResponse.json({ benchmarks });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
