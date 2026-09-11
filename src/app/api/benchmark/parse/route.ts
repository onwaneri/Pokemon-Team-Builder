import { NextResponse } from 'next/server';
import { parseBenchmarkDescription } from '@/lib/benchmarks/parse';
import { evaluateBenchmarks, type EvalMon } from '@/lib/benchmarks/evaluate';
import type { Benchmark } from '@/lib/benchmarks/types';
import { resolveAi, AiDenied, denialResponse } from '@/lib/ai/credential';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { description?: string; species?: string; mon?: EvalMon };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { description, species, mon } = body;
  if (!description?.trim() || !species?.trim()) {
    return NextResponse.json({ error: 'description and species are required' }, { status: 400 });
  }

  // The user typed this benchmark, so it is an interactive request: own key or a free one.
  let grant;
  try {
    grant = await resolveAi(req, { interactive: true });
  } catch (e) {
    if (e instanceof AiDenied) return denialResponse(e);
    throw e;
  }

  const check = await parseBenchmarkDescription(description.trim(), species.trim(), grant.client);

  const benchmark: Benchmark = {
    id: crypto.randomUUID(),
    description: description.trim(),
    check: check ?? undefined,
    status: 'needs_review',
  };

  // If the caller sent the current mon, evaluate immediately.
  if (mon && check) {
    const [evaluated] = evaluateBenchmarks(mon, [benchmark]);
    return NextResponse.json({ benchmark: evaluated }, { headers: grant.headers });
  }

  return NextResponse.json({ benchmark }, { headers: grant.headers });
}
