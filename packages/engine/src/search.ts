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

export async function webSearch(query: string, opts: SearchOptions = {}, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError('TAVILY_API_KEY ausente', 'NO_KEY');
  // Checa ANTES de gastar. Busca básica = 1 crédito.
  if (creditsThisMonth() + 1 > MONTHLY_CREDIT_CAP) {
    throw new SearchError(`teto mensal de ${MONTHLY_CREDIT_CAP} créditos Tavily atingido`, 'MONTHLY_CAP');
  }
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
      ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
      ...(opts.excludeDomains?.length ? { exclude_domains: opts.excludeDomains } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new SearchError(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, 'HTTP');
  const body = (await res.json()) as { results?: SearchResult[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 1);
  return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score }));
}

// Lê uma página pela infraestrutura da Tavily (útil onde a VPS é bloqueada, ex.: Amazon).
// Extração básica: no teste de out/2026 não consumiu crédito; mesmo assim passa pelo teto mensal.
export async function webExtract(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError('TAVILY_API_KEY ausente', 'NO_KEY');
  if (creditsThisMonth() + 1 > MONTHLY_CREDIT_CAP) throw new SearchError('teto mensal Tavily atingido', 'MONTHLY_CAP');
  const res = await fetchImpl('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [url], extract_depth: 'basic', include_usage: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new SearchError(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, 'HTTP');
  const body = (await res.json()) as { results?: { raw_content?: string }[]; usage?: { credits?: number } };
  charge(body.usage?.credits ?? 0);
  const text = body.results?.[0]?.raw_content ?? '';
  if (text.length < 200) throw new SearchError(`extração vazia para ${url}`, 'HTTP');
  return text;
}
