import { z } from 'zod';
import { secret } from './secrets.ts';
import { ENV_FILE_PATH as ENV_FILE } from './env.ts';
import { recordCharge } from './credits.ts';
import { creditsFor, fallbackFor, MODELS, type Role } from './models.ts';


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
    readonly code: 'NO_CREDENTIALS' | 'HTTP' | 'INVALID_OUTPUT' | 'BUDGET_EXCEEDED' | 'NETWORK',
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
export function addSpend(credits: number, what = 'outro', model = '-'): void {
  budget.spent += credits;
  recordCharge(what, model, credits, false);
}

// Chamada única, JSON-in/JSON-out. Saída inválida ganha uma nova tentativa com o erro de validação;
// se falhar de novo, o estágio para (SAFE_STOP) em vez de seguir com dado ruim.
export async function callJson<T>(call: LlmCall<T>, fetchImpl: FetchLike = fetch): Promise<LlmResult<T>> {
  const key = secret('llm');
  // Hostinger AI Router (sucessor do nexos.ai para contas Hostinger; chaves sk-hstgr-).
  const base = (process.env.NEXOS_BASE_URL ?? 'https://router.hostinger.com/v1').replace(/\/$/, '');
  if (!key) throw new LlmError(`NEXOS_API_KEY ausente (ambiente ou ${ENV_FILE})`, 'NO_CREDENTIALS');

  // BEM_MODEL_<PAPEL> troca o modelo de um papel sem mexer no código (avaliações, emergência).
  const override = process.env[`BEM_MODEL_${call.role.toUpperCase()}`];
  let model: { id: string; name: string } = override ? { id: override, name: override } : MODELS[call.role];
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
    const payload = (id: string) => ({
      model: id,
      messages,
      max_tokens: call.maxTokens ?? 8000,
      // Streaming: com modelo que transmite de verdade, os tokens chegam antes dos 100 s da Cloudflare.
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_schema', json_schema: { name: call.schemaName, schema: jsonSchema, strict: false } },
    });
    let r: Awaited<ReturnType<typeof postWithRetry>>;
    try {
      r = await postWithRetry(fetchImpl, `${base}/chat/completions`, key, payload(model.id));
    } catch (e) {
      // 524 persistente: a mesma chamada vai para o modelo reserva do papel (se houver).
      const fb = fallbackFor(call.role);
      if (!(e instanceof LlmError && e.message.startsWith('HTTP 524')) || !fb || model.id === fb.id) throw e;
      model = fb;
      r = await postWithRetry(fetchImpl, `${base}/chat/completions`, key, payload(model.id));
    }
    const { content, usage: u } = r;
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    // Valor cobrado pelo roteador quando vem na resposta; tabela de preços só como estimativa.
    const charged = u.credits ?? creditsFor(call.role, u);
    budget.spent += charged;
    recordCharge(call.role, model.id, charged, u.credits === undefined);

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

// Até duas novas tentativas espaçadas para erro transitório do roteador/Cloudflare; erro de crédito ou de
// chave não se repete. Os testes zeram a espera com BEM_RETRY_MS=0.
const RETRY_WAIT = [15_000, 45_000];
async function postWithRetry(fetchImpl: FetchLike, url: string, key: string, payload: unknown) {
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600_000),
      });
      if (res.ok) return await readCompletion(res);
    } catch (e) {
      // Conexão cortada (ECONNRESET, "fetch failed"), inclusive no meio da resposta em streaming: tenta de
      // novo como erro transitório. 21/10: um corte derrubou o ciclo e jogou fora a pesquisa já feita.
      if (e instanceof LlmError) throw e;
      if (i < RETRY_WAIT.length) {
        await new Promise((r) => setTimeout(r, Number(process.env.BEM_RETRY_MS ?? RETRY_WAIT[i])));
        continue;
      }
      throw new LlmError(`rede: ${(e as Error).message}${(e as { cause?: { code?: string } }).cause?.code ? ` (${(e as { cause: { code: string } }).cause.code})` : ''}`, 'NETWORK');
    }
    const detail = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
    if (i < RETRY_WAIT.length && TRANSIENT.has(res.status)) {
      await new Promise((r) => setTimeout(r, Number(process.env.BEM_RETRY_MS ?? RETRY_WAIT[i])));
      continue;
    }
    throw new LlmError(`HTTP ${res.status} ${detail}`, 'HTTP');
  }
}

// Aceita tanto SSE (stream) quanto JSON comum (os testes e alguns fornecedores devolvem JSON).
type RawUsage = { prompt_tokens?: number; completion_tokens?: number; credits_charged?: number };
async function readCompletion(res: Response): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number; credits?: number } }> {
  const usage: { input_tokens: number; output_tokens: number; credits?: number } = { input_tokens: 0, output_tokens: 0 };
  const take = (u?: RawUsage) => {
    if (u?.prompt_tokens) usage.input_tokens = u.prompt_tokens;
    if (u?.completion_tokens) usage.output_tokens = u.completion_tokens;
    if (typeof u?.credits_charged === 'number') usage.credits = u.credits_charged;
  };
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: RawUsage;
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
        usage?: RawUsage;
      };
      content += evt.choices?.[0]?.delta?.content ?? '';
      take(evt.usage);
    } catch {
      // linha de keep-alive ou fragmento não-JSON: ignorar
    }
  }
  return { content, usage };
}

export function safeParse<T>(content: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  // Alguns modelos embrulham o JSON em ```json ... ``` (às vezes com texto antes ou depois: 22/10, planejador da
  // pauta "colchão ou cama box"); tirar a embalagem é a única limpeza permitida, o conteúdo nunca muda.
  const t = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(t)?.[1];
  const braces = t.indexOf('{') >= 0 && t.lastIndexOf('}') > t.indexOf('{') ? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1) : t;
  const stripped = fenced ?? (t.startsWith('{') || t.startsWith('[') ? t : braces);
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return { ok: false, error: 'não é JSON válido' };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: z.prettifyError(r.error).slice(0, 1500) };
}
