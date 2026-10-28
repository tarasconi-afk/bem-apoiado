import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import './env.ts';
import { ROOT } from './store.ts';

// Busca na web pela Tavily, com TETO MENSAL DURO (o dono não quer pagar além do plano grátis).
// O contador mensal fica fora do git: /var/lib/bem-apoiado na VPS, .state/ no desenvolvimento.
export const MONTHLY_CREDIT_CAP = Number(process.env.TAVILY_MONTHLY_CAP ?? 1400);
const STATE_DIR = process.env.BEM_STATE_DIR ?? (existsSync('/var/lib/bem-apoiado') ? '/var/lib/bem-apoiado' : join(ROOT, '.state'));
const LEDGER = join(STATE_DIR, 'tavily-usage.json');

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

// Cota do plano Tavily esgotada (432 plano, 433 pague-pelo-uso; 401 chave sem crédito também aparece assim): é o
// mesmo que o teto mensal, e não "busca sem resultado". Tratada como HTTP, cada busca falhava calada, a descoberta
// achava 0 fontes e o motor adiava pautas e gastava tentativas de lacuna como se não houvesse fonte (23/10).
async function httpError(res: Response): Promise<SearchError> {
  const text = (await res.text()).slice(0, 200);
  const quota = res.status === 432 || res.status === 433 || (res.status === 429 && /limit|quota|credit/i.test(text));
  return new SearchError(`${quota ? 'cota do plano Tavily esgotada: ' : ''}HTTP ${res.status} ${text}`, quota ? 'MONTHLY_CAP' : 'HTTP', res.status);
}

// Dar a chave por esgotada no mês é decisão séria (ela some até virar o mês), então só vale para os códigos que
// a Tavily usa para dizer "acabou o plano". Um 429 pode ser só excesso de chamadas por minuto: ele ainda manda o
// motor para a reserva naquela busca, mas não queima a conta.
const PLANO_ESGOTADO = new Set([432, 433]);

export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_KEY' | 'MONTHLY_CAP' | 'HTTP',
    readonly status?: number,
  ) {
    super(message);
  }
}

const month = (d = new Date()) => d.toISOString().slice(0, 7);

export function creditsThisMonth(): number {
  if (!existsSync(LEDGER)) return 0;
  const l = JSON.parse(readFileSync(LEDGER, 'utf8')) as Record<string, number>;
  return l[month()] ?? 0;
}

function charge(credits: number, keyId = 'env'): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const l: Record<string, number> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  l[month()] = (l[month()] ?? 0) + credits;
  writeFileSync(`${LEDGER}.tmp`, JSON.stringify(l, null, 2));
  renameSync(`${LEDGER}.tmp`, LEDGER);
  const b = readByKey();
  const m = b[month()] ?? (b[month()] = {});
  m[keyId] = (m[keyId] ?? 0) + credits;
  writeFileSync(`${BY_KEY}.tmp`, JSON.stringify(b, null, 2));
  renameSync(`${BY_KEY}.tmp`, BY_KEY);
}

// Várias contas Tavily, uma por vez (28/10, decisão do editor: o plano grátis de uma conta não cobre o ritmo do
// motor, e criar outra conta com outro email funcionou no Ferramenta Clara). Cada conta tem o seu teto mensal;
// o motor usa a primeira que ainda tem folga e só cai no Brave quando TODAS acabarem. As chaves ficam fora do
// git, num arquivo de estado que só o usuário do motor lê, e o editor as cadastra pelo painel.
const BY_KEY = join(STATE_DIR, 'tavily-usage-by-key.json');
const KEYS_FILE = join(STATE_DIR, 'tavily-keys.json');

export interface TavilyKey { id: string; key: string; label: string; added_at: string }

const readByKey = (): Record<string, Record<string, number>> => (existsSync(BY_KEY) ? JSON.parse(readFileSync(BY_KEY, 'utf8')) : {});
export const usageByKey = (): Record<string, number> => readByKey()[month()] ?? {};

// A chave do env continua valendo e vem primeiro: nada quebra em quem já tem só ela.
export function tavilyKeys(): TavilyKey[] {
  const env = process.env.TAVILY_API_KEY;
  const extra: TavilyKey[] = existsSync(KEYS_FILE) ? (JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys ?? []) : [];
  return [...(env ? [{ id: 'env', key: env, label: 'chave principal (env)', added_at: '' }] : []), ...extra.filter((k) => k.key !== env)];
}

// Nunca devolve a chave inteira: o painel mostra só o fim, para o editor reconhecer qual é.
export const maskKey = (k: string) => `…${k.slice(-4)}`;

function writeKeys(keys: TavilyKey[]): void {
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(`${KEYS_FILE}.tmp`, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
  renameSync(`${KEYS_FILE}.tmp`, KEYS_FILE);
}

export function addTavilyKey(key: string, label: string, now = new Date()): TavilyKey | string {
  const k = key.trim();
  if (!/^tvly-[A-Za-z0-9_-]{10,}$/.test(k)) return 'a chave da Tavily começa com "tvly-"; confira se copiou inteira';
  if (tavilyKeys().some((x) => x.key === k)) return 'essa chave já está cadastrada';
  const cur: TavilyKey[] = existsSync(KEYS_FILE) ? (JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys ?? []) : [];
  const fresh: TavilyKey = { id: `k_${createHash('sha1').update(k).digest('hex').slice(0, 8)}`, key: k, label: label.trim().slice(0, 40) || 'conta extra', added_at: now.toISOString() };
  writeKeys([...cur, fresh]);
  return fresh;
}

export function removeTavilyKey(id: string): string | null {
  if (id === 'env') return null; // a do env sai de /etc/bem-apoiado/env, não daqui
  const cur: TavilyKey[] = existsSync(KEYS_FILE) ? (JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys ?? []) : [];
  const hit = cur.find((k) => k.id === id);
  if (!hit) return null;
  writeKeys(cur.filter((k) => k !== hit));
  return hit.label;
}

// Primeira chave com folga no mês. Sem nenhuma, é teto mensal (não "sem chave"): quem chama cai no Brave.
function pickKey(): TavilyKey {
  const keys = tavilyKeys();
  if (!keys.length) throw new SearchError('nenhuma chave Tavily cadastrada', 'NO_KEY');
  const used = usageByKey();
  const free = keys.find((k) => (used[k.id] ?? 0) + 1 <= MONTHLY_CREDIT_CAP);
  if (!free) throw new SearchError(`teto mensal de ${MONTHLY_CREDIT_CAP} créditos atingido nas ${keys.length} chave(s) Tavily`, 'MONTHLY_CAP');
  return free;
}

// A conta pode acabar antes do nosso contador (crédito gasto fora do motor). Quando a própria Tavily diz que a
// cota acabou, a chave é dada por esgotada no mês e a próxima assume, em vez de o motor ficar insistindo nela.
function exhaust(keyId: string): void {
  const b = readByKey();
  const m = b[month()] ?? (b[month()] = {});
  m[keyId] = MONTHLY_CREDIT_CAP;
  mkdirSync(dirname(BY_KEY), { recursive: true });
  writeFileSync(`${BY_KEY}.tmp`, JSON.stringify(b, null, 2));
  renameSync(`${BY_KEY}.tmp`, BY_KEY);
}

export interface SearchOptions {
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

// A Tavily recusa a busca inteira (HTTP 400) se um item de include_domains não for domínio. Em 22/10 o
// planejador copiou do pedido do editor um link (https://bemapoiado.com/como-escolher-colchao/) e o ajuste
// morreu antes de escrever. Aqui vira só o host; o que não for host some.
export function cleanDomains(list: string[] | undefined): string[] {
  const out = (list ?? []).map((d) => {
    const t = d.trim().toLowerCase();
    try {
      return new URL(/^[a-z]+:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  });
  return [...new Set(out.filter((h) => /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(h)))];
}

// Busca com reserva (23/10): a Tavily responde; se a cota dela acabou, a chave falta ou o serviço caiu (5xx), a Brave
// Search responde no lugar, com teto próprio. Sem chave da Brave, o erro da Tavily segue como antes.
export async function webSearch(query: string, opts: SearchOptions = {}, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  try {
    return await tavilySearch(query, opts, fetchImpl);
  } catch (e) {
    const fallback = e instanceof SearchError && (e.code !== 'HTTP' || /^HTTP 5\d\d/.test(e.message));
    if (!fallback || !process.env.BRAVE_API_KEY) throw e;
    return braveSearch(query, opts, fetchImpl);
  }
}

// Brave Search API (pré-pago: US$ 5 por 1.000 buscas, com US$ 5 grátis por mês; o dono não quer pagar). Teto de 900
// por mês para nunca passar do crédito grátis. Não tem include_domains: vira "site:" na consulta e o resultado é
// filtrado pelo domínio. Na Amazon rende menos que a Tavily (23/10: 4 anúncios contra 9, resumo de 200 letras contra
// 1.100, e não acha anúncio pelo código), então fica só como reserva.
export const BRAVE_MONTHLY_CAP = Number(process.env.BRAVE_MONTHLY_CAP ?? 900);
const BRAVE_LEDGER = join(STATE_DIR, 'brave-usage.json');
export function braveThisMonth(): number {
  if (!existsSync(BRAVE_LEDGER)) return 0;
  return (JSON.parse(readFileSync(BRAVE_LEDGER, 'utf8')) as Record<string, number>)[month()] ?? 0;
}
let braveLast = 0;
export async function braveSearch(query: string, opts: SearchOptions = {}, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new SearchError('BRAVE_API_KEY ausente', 'NO_KEY');
  if (braveThisMonth() + 1 > BRAVE_MONTHLY_CAP) throw new SearchError(`teto mensal de ${BRAVE_MONTHLY_CAP} buscas Brave atingido (reserva da Tavily)`, 'MONTHLY_CAP');
  const include = cleanDomains(opts.includeDomains).filter((d) => !d.startsWith('*.')).slice(0, 5);
  const exclude = cleanDomains(opts.excludeDomains).filter((d) => !d.startsWith('*.')).slice(0, 5);
  const q = [query, include.length ? `(${include.map((d) => `site:${d}`).join(' OR ')})` : '', ...exclude.map((d) => `-site:${d}`)].filter(Boolean).join(' ');
  const wait = braveLast + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  braveLast = Date.now();
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: String(Math.min(opts.maxResults ?? 8, 20)), country: 'BR', search_lang: 'pt-br' })}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new SearchError(`Brave: HTTP ${res.status} ${text}`, res.status === 429 && /quota|limit/i.test(text) ? 'MONTHLY_CAP' : 'HTTP');
  }
  mkdirSync(dirname(BRAVE_LEDGER), { recursive: true });
  const l: Record<string, number> = existsSync(BRAVE_LEDGER) ? JSON.parse(readFileSync(BRAVE_LEDGER, 'utf8')) : {};
  l[month()] = (l[month()] ?? 0) + 1;
  writeFileSync(BRAVE_LEDGER, JSON.stringify(l, null, 2));
  const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const strip = (t: string) => t.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return (body.web?.results ?? [])
    .filter((r) => !include.length || include.some((d) => host(r.url) === d || host(r.url).endsWith(`.${d}`)))
    .map((r, i) => ({ title: strip(r.title), url: r.url, content: strip(r.description ?? ''), score: Math.max(0.1, 0.9 - i * 0.05) }));
}

async function tavilySearch(query: string, opts: SearchOptions = {}, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  // Checa ANTES de gastar. Busca básica = 1 crédito. A chave é a primeira com folga no mês.
  const { id, key } = pickKey();
  const includeDomains = cleanDomains(opts.includeDomains);
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: opts.maxResults ?? 8,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
      country: 'brazil',
      ...(includeDomains.length ? { include_domains: includeDomains } : {}),
      ...(opts.excludeDomains?.length ? { exclude_domains: opts.excludeDomains } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await httpError(res);
    // Cota desta conta acabou: marca a chave e tenta a próxima na mesma busca, sem gastar uma rodada do motor.
    if (err.code === 'MONTHLY_CAP' && PLANO_ESGOTADO.has(err.status ?? 0)) {
      exhaust(id);
      if (tavilyKeys().some((k) => (usageByKey()[k.id] ?? 0) + 1 <= MONTHLY_CREDIT_CAP)) return tavilySearch(query, opts, fetchImpl);
    }
    throw err;
  }
  const body = (await res.json()) as { results?: SearchResult[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 1, id);
  return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score }));
}

// Lê uma página pela infraestrutura da Tavily (útil onde a VPS é bloqueada, ex.: Amazon).
// Extração básica: no teste de out/2026 não consumiu crédito; mesmo assim passa pelo teto mensal.
// Página de loja às vezes volta vazia para leitor automático (21/10: os 5 anúncios de travesseiro). Nesse
// caso, uma nova tentativa com extract_depth "advanced" (2 créditos Tavily) antes de desistir.
export async function webExtract(url: string, fetchImpl: typeof fetch = fetch, depth: 'basic' | 'advanced' = 'basic'): Promise<string> {
  const { id, key } = pickKey();
  const res = await fetchImpl('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [url], extract_depth: depth, include_usage: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await httpError(res);
    if (err.code === 'MONTHLY_CAP' && PLANO_ESGOTADO.has(err.status ?? 0)) {
      exhaust(id);
      if (tavilyKeys().some((k) => (usageByKey()[k.id] ?? 0) + 1 <= MONTHLY_CREDIT_CAP)) return webExtract(url, fetchImpl, depth);
    }
    throw err;
  }
  const body = (await res.json()) as { results?: { raw_content?: string }[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 0, id);
  const text = body.results?.[0]?.raw_content ?? '';
  if (text.length < 200) {
    if (depth === 'basic' && /amazon\./.test(url)) return webExtract(url, fetchImpl, 'advanced');
    throw new SearchError(`extração vazia para ${url}`, 'HTTP');
  }
  return text;
}
