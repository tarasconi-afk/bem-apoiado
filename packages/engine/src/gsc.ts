import { createSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DATA, readJsonDir, STATE_DIR, writeJson } from './store.ts';
export const HOME_ORDER_FILE = join(DATA, 'home-order.json');

// Google Search Console: o que o Google mostra de nós (cliques, impressões, CTR, posição por página e
// por busca). Lido por conta de serviço (só leitura), sem biblioteca do Google: JWT assinado aqui.
// Um retrato por dia no diretório de estado da VPS (fora do git: senão todo dia viraria um ramo para
// aceitar). No git entra só o que muda o site: a ordem da home (data/home-order.json) e pautas novas. Uso: ordenar a home, sugerir pauta a partir
// de busca sem página, apontar página quase na 1ª página ou com CTR baixo.

export const GSC_SITE = process.env.BEM_GSC_SITE ?? 'sc-domain:bemapoiado.com';
const KEY_FILE = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'gsc-key.json');
const GSC_DIR = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'gsc');

export const ServiceKey = z.object({ client_email: z.string().email(), private_key: z.string().includes('PRIVATE KEY'), token_uri: z.string().url().default('https://oauth2.googleapis.com/token') });
export type ServiceKey = z.infer<typeof ServiceKey>;

// Texto colado de editor (TextEdit/Notas) vem com aspas curvas e espaços especiais: normaliza antes.
// Erro nunca devolve trecho do texto (seria pedaço da chave privada na tela ou no log).
export function saveKey(json: string): ServiceKey {
  const clean = json.replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u00A0/g, ' ').trim();
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch {
    throw new Error('o conteúdo não é um JSON válido; envie o arquivo .json baixado do Google (botão "Escolher arquivo")');
  }
  const parsed = ServiceKey.safeParse(raw);
  if (!parsed.success) throw new Error('JSON sem client_email/private_key: confira se é a chave da conta de serviço (tipo service_account)');
  const k = parsed.data;
  writeFileSync(KEY_FILE(), JSON.stringify(k), { mode: 0o600 });
  return k;
}
export const hasKey = () => existsSync(KEY_FILE());
export const keyEmail = () => (hasKey() ? (JSON.parse(readFileSync(KEY_FILE(), 'utf8')) as ServiceKey).client_email : null);

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

const READ = 'https://www.googleapis.com/auth/webmasters.readonly';
export function signedJwt(k: ServiceKey, now = Math.floor(Date.now() / 1000), scope = READ): string {
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ iss: k.client_email, scope, aud: k.token_uri, iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(k.private_key);
  return `${head}.${claims}.${b64(sig)}`;
}

async function accessToken(k: ServiceKey, f: typeof fetch, scope = READ): Promise<string> {
  const r = await f(k.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt(k, undefined, scope) }),
  });
  if (!r.ok) throw new Error(`GSC token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

export const GscRow = z.object({ page: z.string(), query: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() });
export const GscSnapshot = z.object({ site: z.string(), start: z.string(), end: z.string(), fetched_at: z.string(), rows: z.array(GscRow) });
export type GscSnapshot = z.infer<typeof GscSnapshot>;

// Últimos 28 dias até 3 dias atrás (o Search Console consolida com atraso).
export async function fetchSnapshot(f: typeof fetch = fetch, now = new Date()): Promise<GscSnapshot> {
  if (!hasKey()) throw new Error('Search Console não conectado (cole a chave da conta de serviço no painel)');
  const k = ServiceKey.parse(JSON.parse(readFileSync(KEY_FILE(), 'utf8')));
  const token = await accessToken(k, f);
  const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
  // O Search Console fecha o dia com ~2 dias de atraso (26/10: o export do editor já trazia o dia 24).
  const [start, end] = [day(30), day(2)];
  const r = await f(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: start, endDate: end, dimensions: ['page', 'query'], rowLimit: 5000 }),
  });
  if (!r.ok) throw new Error(`GSC consulta: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { rows?: { keys: [string, string]; clicks: number; impressions: number; ctr: number; position: number }[] };
  const rows = (body.rows ?? []).map((x) => ({ page: x.keys[0], query: x.keys[1], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position }));
  const snap = GscSnapshot.parse({ site: GSC_SITE, start, end, fetched_at: now.toISOString(), rows });
  writeJson(join(GSC_DIR(), `${now.toISOString().slice(0, 10)}.json`), snap);
  return snap;
}

export function latestSnapshot(): GscSnapshot | null {
  if (!existsSync(GSC_DIR())) return null;
  const all = readJsonDir(GSC_DIR(), (v) => GscSnapshot.parse(v));
  return all.at(-1) ?? null;
}

export interface PageStats { slug: string; clicks: number; impressions: number; ctr: number; position: number; queries: { query: string; impressions: number; position: number }[] }

const slugOfUrl = (u: string) => new URL(u).pathname.replace(/^\/|\/$/g, '') || '';

export function pageStats(s: GscSnapshot): Map<string, PageStats> {
  const out = new Map<string, PageStats>();
  for (const r of s.rows) {
    const slug = slugOfUrl(r.page);
    const p = out.get(slug) ?? { slug, clicks: 0, impressions: 0, ctr: 0, position: 0, queries: [] };
    // Posição média ponderada por impressão.
    p.position = (p.position * p.impressions + r.position * r.impressions) / Math.max(p.impressions + r.impressions, 1);
    p.clicks += r.clicks;
    p.impressions += r.impressions;
    p.queries.push({ query: r.query, impressions: r.impressions, position: r.position });
    out.set(slug, p);
  }
  for (const p of out.values()) {
    p.ctr = p.impressions ? p.clicks / p.impressions : 0;
    p.queries.sort((a, b) => b.impressions - a.impressions);
  }
  return out;
}

// O que fazer com os dados. Limiares conservadores: com pouco tráfego, nada vira ação.
export interface Opportunities {
  newTopics: { query: string; impressions: number; page: string }[]; // busca forte sem página própria
  strikingDistance: PageStats[]; // posição 8–20 com impressões: melhorar a página rende mais
  lowCtr: PageStats[]; // muita impressão, pouco clique: título/descrição
}

export function opportunities(s: GscSnapshot, existingSlugs: Set<string>, queued: Set<string>, slugOf: (q: string) => string): Opportunities {
  const stats = [...pageStats(s).values()].filter((p) => existingSlugs.has(p.slug));
  const byQuery = new Map<string, { impressions: number; page: string }>();
  for (const r of s.rows) {
    const q = byQuery.get(r.query) ?? { impressions: 0, page: slugOfUrl(r.page) };
    q.impressions += r.impressions;
    byQuery.set(r.query, q);
  }
  const newTopics = [...byQuery]
    .filter(([q, v]) => v.impressions >= 20 && !existingSlugs.has(slugOf(q)) && !queued.has(slugOf(q)) && q.split(/\s+/).length >= 2)
    .map(([query, v]) => ({ query, ...v }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);
  return {
    newTopics,
    strikingDistance: stats.filter((p) => p.impressions >= 50 && p.position >= 8 && p.position <= 20).sort((a, b) => b.impressions - a.impressions),
    lowCtr: stats.filter((p) => p.impressions >= 100 && p.ctr < 0.01).sort((a, b) => b.impressions - a.impressions),
  };
}

// Ordem da home: mais cliques, depois mais impressões; páginas sem dado mantêm a ordem por data.
export function homeOrder(s: GscSnapshot, slugs: string[]): string[] {
  const st = pageStats(s);
  const score = (x: string) => [st.get(x)?.clicks ?? 0, st.get(x)?.impressions ?? 0] as const;
  return [...slugs].sort((a, b) => score(b)[0] - score(a)[0] || score(b)[1] - score(a)[1]);
}

// Reenvio do sitemap quando o site publica página nova ou atualizada (23/10). Exige escopo de escrita e a conta de
// serviço como usuário "Completo" na propriedade; com acesso "Restrito" o Google responde 403 e nada muda.
export async function submitSitemap(sitemapUrl: string, f: typeof fetch = fetch): Promise<'ok' | 'sem-permissao'> {
  if (!hasKey()) throw new Error('Search Console não conectado');
  const k = ServiceKey.parse(JSON.parse(readFileSync(KEY_FILE(), 'utf8')));
  const token = await accessToken(k, f, 'https://www.googleapis.com/auth/webmasters');
  const r = await f(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/sitemaps/${encodeURIComponent(sitemapUrl)}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } });
  if (r.status === 403) return 'sem-permissao';
  if (!r.ok) throw new Error(`GSC sitemap: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return 'ok';
}
