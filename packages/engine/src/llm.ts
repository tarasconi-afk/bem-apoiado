import { z } from 'zod';
import { ENV_FILE_PATH as ENV_FILE } from './env.ts';
import { creditsFor, MODELS, type Role } from './models.ts';


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
    readonly code: 'NO_CREDENTIALS' | 'HTTP' | 'INVALID_OUTPUT' | 'BUDGET_EXCEEDED',
  ) {
    super(message);
  }
}

// Teto de gasto por execução (créditos Hostinger). Checado antes de cada chamada; ao estourar, a
// etapa para com SAFE_STOP. Uma execução autônoma nunca gasta sem limite.
const budget = { limit: Number.POSITIVE_INFINITY, spent: 0 };
export function setRunBudget(limitCredits: number): void {
  budget.limit = limitCredits;
  budget.spent = 0;
}
export const creditsSpent = (): number => budget.spent;
export const creditsLeft = (): number => budget.limit - budget.spent;
// Gasto de chamadas fora do chat (ex.: Jev) também conta no teto da execução.
export function addSpend(credits: number): void {
  budget.spent += credits;
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
  // O roteador não impõe response_format para todos os fornecedores (o Claude trocou question_id por
  // question). Por isso o schema também vai no prompt, com os nomes exatos dos campos.
  const contract =
    `\n\nFormato de resposta: apenas um objeto JSON válido, sem texto antes ou depois, que siga exatamente ` +
    `este JSON Schema (use os nomes de campo exatamente como estão):\n${JSON.stringify(jsonSchema)}`;
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: call.system + contract },
    { role: 'user', content: call.user },
  ];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (budget.spent >= budget.limit) {
      throw new LlmError(`teto de ${budget.limit} créditos atingido (gasto ${budget.spent.toFixed(1)})`, 'BUDGET_EXCEEDED');
    }
    const { content, usage: u } = await postWithRetry(fetchImpl, `${base}/chat/completions`, key, {
      model: model.id,
      messages,
      max_tokens: call.maxTokens ?? 8000,
      // Streaming: respostas longas (redator) passam de 100 s, e a Cloudflare na frente do roteador
      // derruba conexão ociosa com 524. Com stream, os tokens chegam continuamente.
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_schema', json_schema: { name: call.schemaName, schema: jsonSchema, strict: false } },
    });
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    budget.spent += creditsFor(call.role, u);

    const parsed = safeParse(content, call.schema);
    if (parsed.ok) return { data: parsed.data, model: model.id, modelName: model.name, usage, attempts: attempt };
    lastProblem = `${parsed.error.slice(0, 400)} | ${content.length} chars | início: ${content.slice(0, 120).replace(/\s+/g, ' ')} | fim: ${content.slice(-200).replace(/\s+/g, ' ')}`;

    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `A saída não passou na validação: ${parsed.error}\nDevolva apenas o JSON corrigido.` },
    );
  }
  throw new LlmError(`${model.name} devolveu saída inválida duas vezes (${call.schemaName}): ${lastProblem}`, 'INVALID_OUTPUT');
}

const TRANSIENT = new Set([429, 500, 502, 503, 504, 520, 522, 524, 529]);

// Uma nova tentativa para erro transitório do roteador/Cloudflare; erro de crédito ou de chave não se repete.
async function postWithRetry(fetchImpl: FetchLike, url: string, key: string, payload: unknown) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });
    if (res.ok) return readCompletion(res);
    const detail = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
    if (i === 0 && TRANSIENT.has(res.status)) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    throw new LlmError(`HTTP ${res.status} ${detail}`, 'HTTP');
  }
}

// Aceita tanto SSE (stream) quanto JSON comum (os testes e alguns fornecedores devolvem JSON).
async function readCompletion(res: Response): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number } }> {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const take = (u?: { prompt_tokens?: number; completion_tokens?: number }) => {
    if (u?.prompt_tokens) usage.input_tokens = u.prompt_tokens;
    if (u?.completion_tokens) usage.output_tokens = u.completion_tokens;
  };
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    take(body.usage);
    return { content: body.choices?.[0]?.message?.content ?? '', usage };
  }
  let content = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const evt = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      content += evt.choices?.[0]?.delta?.content ?? '';
      take(evt.usage);
    } catch {
      // linha de keep-alive ou fragmento não-JSON: ignorar
    }
  }
  return { content, usage };
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
