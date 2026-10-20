import { existsSync } from 'node:fs';
import { z } from 'zod';
import { MODELS, type Role } from './models.ts';

// Credenciais: variáveis de ambiente, com fallback para o arquivo da VPS. Nunca no repositório.
const ENV_FILE = '/etc/bem-apoiado/env';
if (!process.env.NEXOS_API_KEY && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export interface LlmCall<T> {
  role: Role;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  model: string;
  modelName: string;
  usage: { input_tokens: number; output_tokens: number };
  attempts: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_CREDENTIALS' | 'HTTP' | 'INVALID_OUTPUT',
  ) {
    super(message);
  }
}

// Chamada única, JSON-in/JSON-out. Saída inválida ganha uma nova tentativa com o erro de validação;
// se falhar de novo, o estágio para (SAFE_STOP) em vez de seguir com dado ruim.
export async function callJson<T>(call: LlmCall<T>, fetchImpl: FetchLike = fetch): Promise<LlmResult<T>> {
  const key = process.env.NEXOS_API_KEY;
  // Hostinger AI Router (sucessor do nexos.ai para contas Hostinger; chaves sk-hstgr-).
  const base = (process.env.NEXOS_BASE_URL ?? 'https://router.hostinger.com/v1').replace(/\/$/, '');
  if (!key) throw new LlmError(`NEXOS_API_KEY ausente (ambiente ou ${ENV_FILE})`, 'NO_CREDENTIALS');

  const model = MODELS[call.role];
  const jsonSchema = z.toJSONSchema(call.schema, { target: 'draft-7' });
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: call.system },
    { role: 'user', content: call.user },
  ];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        messages,
        max_tokens: call.maxTokens ?? 8000,
        response_format: { type: 'json_schema', json_schema: { name: call.schemaName, schema: jsonSchema, strict: false } },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new LlmError(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, 'HTTP');
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage.input_tokens += body.usage?.prompt_tokens ?? 0;
    usage.output_tokens += body.usage?.completion_tokens ?? 0;
    const content = body.choices?.[0]?.message?.content ?? '';

    const parsed = safeParse(content, call.schema);
    if (parsed.ok) return { data: parsed.data, model: model.id, modelName: model.name, usage, attempts: attempt };

    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `A saída não passou na validação: ${parsed.error}\nDevolva apenas o JSON corrigido.` },
    );
  }
  throw new LlmError(`${model.name} devolveu saída inválida duas vezes (${call.schemaName})`, 'INVALID_OUTPUT');
}

function safeParse<T>(content: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  // Alguns modelos embrulham o JSON em ```json ... ```; isso é a única limpeza permitida.
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return { ok: false, error: 'não é JSON válido' };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: z.prettifyError(r.error).slice(0, 1500) };
}
