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
  return new SearchError(`${quota ? 'cota do plano Tavily esgotada: ' : ''}HTTP ${res.status} ${text}`, quota ? 'MONTHLY_CAP' : 'HTTP');
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_KEY' | 'MONTHLY_CAP' | 'HTTP',
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

function charge(credits: number): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const l: Record<string, number> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  l[month()] = (l[month()] ?? 0) + credits;
  writeFileSync(`${LEDGER}.tmp`, JSON.stringify(l, null, 2));
  renameSync(`${LEDGER}.tmp`, LEDGER);
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
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError('TAVILY_API_KEY ausente', 'NO_KEY');
  // Checa ANTES de gastar. Busca básica = 1 crédito.
  if (creditsThisMonth() + 1 > MONTHLY_CREDIT_CAP) {
    throw new SearchError(`teto mensal de ${MONTHLY_CREDIT_CAP} créditos Tavily atingido`, 'MONTHLY_CAP');
  }
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
  if (!res.ok) throw await httpError(res);
  const body = (await res.json()) as { results?: SearchResult[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 1);
  return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score }));
}

// Lê uma página pela infraestrutura da Tavily (útil onde a VPS é bloqueada, ex.: Amazon).
// Extração básica: no teste de out/2026 não consumiu crédito; mesmo assim passa pelo teto mensal.
// Página de loja às vezes volta vazia para leitor automático (21/10: os 5 anúncios de travesseiro). Nesse
// caso, uma nova tentativa com extract_depth "advanced" (2 créditos Tavily) antes de desistir.
export async function webExtract(url: string, fetchImpl: typeof fetch = fetch, depth: 'basic' | 'advanced' = 'basic'): Promise<string> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError('TAVILY_API_KEY ausente', 'NO_KEY');
  if (creditsThisMonth() + 1 > MONTHLY_CREDIT_CAP) throw new SearchError('teto mensal Tavily atingido', 'MONTHLY_CAP');
  const res = await fetchImpl('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [url], extract_depth: depth, include_usage: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await httpError(res);
  const body = (await res.json()) as { results?: { raw_content?: string }[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 0);
  const text = body.results?.[0]?.raw_content ?? '';
  if (text.length < 200) {
    if (depth === 'basic' && /amazon\./.test(url)) return webExtract(url, fetchImpl, 'advanced');
    throw new SearchError(`extração vazia para ${url}`, 'HTTP');
  }
  return text;
}
