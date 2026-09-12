/**
 * Provider-neutral LLM client.
 *
 * Every AI feature in the app talks to one small interface (`LlmClient.generate`) that knows two
 * things: function calling (the tool loop behind chat, the team builder, and the SP optimizer) and
 * schema-constrained JSON (compare sets, roles, benchmark parsing). Four providers implement it:
 * Gemini (native SDK), Anthropic (Messages API), and OpenAI + OpenRouter (the OpenAI-compatible
 * chat/completions shape). Tool schemas throughout the codebase are written in Gemini's
 * `Type.OBJECT` form; `toJsonSchema` converts them for the other providers.
 *
 * Credentials arrive per request (see credential.ts) and are never stored on the client object
 * beyond the call; error messages are scrubbed of the key before they leave this module.
 * Server-only.
 */
import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';

export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'openrouter';

/** Which tier of model a job runs on: `fast` for short structured picks, `smart` for tool loops. */
export type ModelTier = 'fast' | 'smart';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** The model each tier maps to on this provider. Visitors pick a provider; the app picks these. */
  models: Record<ModelTier, string>;
  keyPrefixHint: string;
  consoleUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    models: { fast: 'gpt-5-nano', smart: 'gpt-5-mini' },
    keyPrefixHint: 'sk-…',
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    models: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' },
    keyPrefixHint: 'AIza…',
    consoleUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    models: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-5' },
    keyPrefixHint: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    models: { fast: 'openai/gpt-5-nano', smart: 'openai/gpt-5-mini' },
    keyPrefixHint: 'sk-or-…',
    consoleUrl: 'https://openrouter.ai/keys',
  },
};

/**
 * Every AI job the app runs, mapped to the tier it needs. Tool-driven loops (chat, team builds,
 * SP optimization) need the smarter model; single-shot structured picks (which threats to compare,
 * parsing a benchmark sentence, a team blurb, a paste import, a benchmark evaluation) are fine on
 * the fast one. This is the only place that decision lives.
 */
export type AiJob = 'chat' | 'build' | 'optimize' | 'compare' | 'parse' | 'blurb' | 'import' | 'eval';
export const JOB_TIER: Record<AiJob, ModelTier> = {
  chat: 'smart',
  build: 'smart',
  optimize: 'smart',
  compare: 'fast',
  parse: 'fast',
  blurb: 'fast',
  import: 'fast',
  eval: 'fast',
};

/** The model a job runs on for a provider. Env `AI_MODEL_<PROVIDER>_<TIER>` overrides a tier. */
export function modelFor(provider: ProviderId, job: AiJob): string {
  const tier = JOB_TIER[job];
  const override = process.env[`AI_MODEL_${provider.toUpperCase()}_${tier.toUpperCase()}`];
  return override?.trim() || PROVIDERS[provider].models[tier];
}

export const PROVIDER_IDS: ProviderId[] = ['openai', 'gemini', 'anthropic', 'openrouter'];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && v in PROVIDERS;
}

export interface LlmCredential {
  provider: ProviderId;
  apiKey: string;
  /** Set by resolveAi per job (see modelFor); adapters fall back to the provider's smart tier. */
  model?: string;
}

// ─── Neutral message shape ─────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResult {
  id: string;
  name: string;
  result: unknown;
}
export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; /** Provider-specific echo of the turn (Gemini thought signatures etc.). */ raw?: unknown }
  | { role: 'tool'; results: ToolResult[] };

export interface GenerateOptions {
  system: string;
  messages: LlmMessage[];
  /** Function declarations in Gemini's schema form (as used across the codebase). */
  tools?: FunctionDeclaration[];
  /** Constrain the reply to this JSON schema (Gemini form); `text` then holds the JSON string. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}
export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  /** Provider echo to store on the assistant message (see LlmMessage.raw). */
  raw?: unknown;
}

export interface LlmClient {
  provider: ProviderId;
  model: string;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export class LlmError extends Error {
  status: number;
  provider?: ProviderId;
  constructor(message: string, status = 502, provider?: ProviderId) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
  }
}

function scrub(text: string, apiKey: string): string {
  return apiKey && text.includes(apiKey) ? text.split(apiKey).join('[key]') : text;
}

/**
 * Hard cap on one model call. Serverless hosts kill the whole request at their own limit (60 s on
 * Vercel Hobby) and answer with an HTML timeout page; returning a typed error before that lets the
 * client retry the round with the same state instead of failing the build.
 */
export const LLM_TIMEOUT_MS = 40_000;

async function timedFetch(url: string, init: RequestInit, provider: ProviderId): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(LLM_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LlmError(`The model took longer than ${LLM_TIMEOUT_MS / 1000}s to answer. Retry the request.`, 504, provider);
    }
    throw e;
  }
}

// ─── Schema conversion (Gemini Type form → JSON Schema) ─────────────────────────

type GeminiSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  nullable?: boolean;
};

export function toJsonSchema(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as GeminiSchema;
  const out: Record<string, unknown> = {};
  const t = (s.type ?? '').toString().toLowerCase();
  if (t && t !== 'type_unspecified') out.type = s.nullable ? [t, 'null'] : t;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    if (!out.type) out.type = 'object';
  }
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.required?.length) out.required = s.required;
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

let callCounter = 0;
function nextCallId(): string {
  callCounter = (callCounter + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}_${callCounter}`;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

function geminiClient(cred: LlmCredential): LlmClient {
  const ai = new GoogleGenAI({ apiKey: cred.apiKey, httpOptions: { timeout: LLM_TIMEOUT_MS } });
  const model = cred.model || PROVIDERS.gemini.models.smart;
  return {
    provider: 'gemini',
    model,
    async generate(opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contents: any[] = [];
      for (const m of opts.messages) {
        if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] });
        else if (m.role === 'assistant') {
          if (m.raw) contents.push(m.raw);
          else contents.push({
            role: 'model',
            parts: [
              ...(m.text ? [{ text: m.text }] : []),
              ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
            ],
          });
        } else {
          contents.push({ role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })) });
        }
      }
      try {
        const resp = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system,
            ...(opts.tools?.length ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
            ...(opts.jsonSchema ? { responseMimeType: 'application/json', responseSchema: opts.jsonSchema } : {}),
            ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
          },
        });
        const calls = (resp.functionCalls ?? []).map((c) => ({ id: c.id || nextCallId(), name: c.name ?? 'unknown', args: parseArgs(c.args) }));
        return { text: resp.text ?? '', toolCalls: calls, raw: resp.candidates?.[0]?.content };
      } catch (e) {
        throw new LlmError(scrub((e as Error).message || 'Gemini request failed.', cred.apiKey), 502, 'gemini');
      }
    },
  };
}

// ─── OpenAI-compatible (OpenAI, OpenRouter) ───────────────────────────────────

const OPENAI_BASE: Record<'openai' | 'openrouter', string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

function openAiCompatibleClient(cred: LlmCredential & { provider: 'openai' | 'openrouter' }): LlmClient {
  const base = OPENAI_BASE[cred.provider];
  const model = cred.model || PROVIDERS[cred.provider].models.smart;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
    ...(cred.provider === 'openrouter' ? { 'HTTP-Referer': 'https://vgcforge.com', 'X-Title': 'Forge' } : {}),
  };
  return {
    provider: cred.provider,
    model,
    async generate(opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [{ role: 'system', content: opts.system }];
      for (const m of opts.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: m.text || null,
            ...(m.toolCalls.length
              ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
              : {}),
          });
        } else {
          for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result ?? null) });
        }
      }
      const body: Record<string, unknown> = { model, messages };
      // Reasoning models default to medium effort, which meant 30–130 s per round for what is a
      // tool-lookup workload. Low effort keeps rounds in the single digits of seconds, and the
      // fast tier (single-shot structured picks) barely needs to think at all.
      const reasoning = /^(gpt-5|o\d)/.test(model) || (cred.provider === 'openrouter' && /gpt-5|\/o\d|reasoning|thinking/.test(model));
      if (reasoning) {
        const effort = model === PROVIDERS[cred.provider].models.fast ? 'minimal' : 'low';
        if (cred.provider === 'openrouter') body.reasoning = { effort };
        else { body.reasoning_effort = effort; body.verbosity = 'low'; }
      }
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description ?? '', parameters: toJsonSchema(t.parameters ?? { type: 'OBJECT', properties: {} }) },
        }));
        body.tool_choice = 'auto';
      }
      if (opts.jsonSchema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: toJsonSchema(opts.jsonSchema) } };
      }
      // Reasoning tokens count against the completion cap, so a tight cap meant for the visible
      // answer would otherwise come back empty. Leave room for the thinking.
      if (opts.maxTokens) body.max_completion_tokens = reasoning ? opts.maxTokens + 1500 : opts.maxTokens;

      const res = await timedFetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, cred.provider);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error?.message ?? json?.error ?? `HTTP ${res.status}`;
        throw new LlmError(scrub(String(msg), cred.apiKey), res.status === 401 ? 401 : 502, cred.provider);
      }
      const msg = json?.choices?.[0]?.message ?? {};
      const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: { id?: string; function?: { name?: string; arguments?: string } }) => ({
        id: c.id || nextCallId(),
        name: c.function?.name ?? 'unknown',
        args: parseArgs(c.function?.arguments),
      }));
      const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: { text?: string }) => p.text ?? '').join('') : '';
      return { text: content, toolCalls: calls };
    },
  };
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

const JSON_TOOL = 'emit_result';

function anthropicClient(cred: LlmCredential): LlmClient {
  const model = cred.model || PROVIDERS.anthropic.models.smart;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': cred.apiKey,
    'anthropic-version': '2023-06-01',
  };
  return {
    provider: 'anthropic',
    model,
    async generate(opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [];
      for (const m of opts.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
          const content = [
            ...(m.text ? [{ type: 'text', text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
          ];
          if (content.length) messages.push({ role: 'assistant', content });
        } else {
          messages.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result ?? null) })) });
        }
      }
      const body: Record<string, unknown> = { model, max_tokens: opts.maxTokens ?? 4096, system: opts.system, messages };
      if (opts.jsonSchema) {
        body.tools = [{ name: JSON_TOOL, description: 'Return the result.', input_schema: toJsonSchema(opts.jsonSchema) }];
        body.tool_choice = { type: 'tool', name: JSON_TOOL };
      } else if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: toJsonSchema(t.parameters ?? { type: 'OBJECT', properties: {} }) }));
      }
      const res = await timedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) }, 'anthropic');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error?.message ?? `HTTP ${res.status}`;
        throw new LlmError(scrub(String(msg), cred.apiKey), res.status === 401 ? 401 : 502, 'anthropic');
      }
      const blocks: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] = json?.content ?? [];
      if (opts.jsonSchema) {
        const emit = blocks.find((b) => b.type === 'tool_use' && b.name === JSON_TOOL);
        return { text: JSON.stringify(emit?.input ?? {}), toolCalls: [] };
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const calls: ToolCall[] = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id || nextCallId(), name: b.name ?? 'unknown', args: parseArgs(b.input) }));
      return { text, toolCalls: calls };
    },
  };
}

// ─── Factory + validation ─────────────────────────────────────────────────────

export function createLlmClient(cred: LlmCredential): LlmClient {
  switch (cred.provider) {
    case 'gemini': return geminiClient(cred);
    case 'anthropic': return anthropicClient(cred);
    case 'openai':
    case 'openrouter': return openAiCompatibleClient(cred as LlmCredential & { provider: 'openai' | 'openrouter' });
  }
}

/** Cheapest possible round-trip that proves the key works (a model listing or key-info call). */
export async function validateCredential(cred: LlmCredential): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (cred.provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey: cred.apiKey });
      const pager = await ai.models.list({ config: { pageSize: 1 } });
      void pager;
      return { ok: true };
    }
    if (cred.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, error: scrub(String(j?.error?.message ?? `HTTP ${res.status}`), cred.apiKey) }; }
      return { ok: true };
    }
    const url = cred.provider === 'openrouter' ? 'https://openrouter.ai/api/v1/auth/key' : 'https://api.openai.com/v1/models?limit=1';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cred.apiKey}` } });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, error: scrub(String(j?.error?.message ?? j?.error ?? `HTTP ${res.status}`), cred.apiKey) }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message || 'Validation failed.', cred.apiKey) };
  }
}

/** Last four characters, for "connected as …" display. Never the key itself. */
export function keyFingerprint(apiKey: string): string {
  return apiKey.length > 8 ? `…${apiKey.slice(-4)}` : '…';
}
