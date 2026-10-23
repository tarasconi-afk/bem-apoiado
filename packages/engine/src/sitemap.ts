import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './store.ts';

// Páginas de um fabricante cadastrado sem gastar busca (23/10: a Tavily passou de 680 buscas no mês da implantação).
// O site publica a lista das próprias páginas (sitemap); o motor lê, guarda por 7 dias e escolhe pelas palavras do
// endereço as páginas que falam da pauta. O que sair daqui passa pela mesma triagem e captura de um resultado de busca.

const CACHE_DAYS = 7;
const MAX_CHILD_SITEMAPS = 12;
const MAX_URLS = 20_000;
const UA = 'Mozilla/5.0 (compatible; BemApoiadoBot/1.0; +https://bemapoiado.com/como-trabalhamos/)';
const cacheDir = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'sitemaps');

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/g)].map((m) => m[1]!.trim().replace(/&amp;/g, '&'));

async function get(url: string, f: typeof fetch): Promise<string | null> {
  try {
    const r = await f(url, { headers: { 'user-agent': UA, accept: 'application/xml,text/xml,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 8_000_000);
  } catch {
    return null;
  }
}

// Sitemaps filhos com páginas de produto e conteúdo vêm antes (WordPress e lojas dividem por tipo).
const childRank = (u: string) => (/product|produto|page|pagina|post|blog|catalog|categoria/i.test(u) ? 0 : /image|video|tag|author|autor/i.test(u) ? 2 : 1);

export async function siteUrls(host: string, f: typeof fetch = fetch, now = new Date()): Promise<string[]> {
  const file = join(cacheDir(), `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { at: string; urls: string[] };
    if (now.getTime() - Date.parse(c.at) < CACHE_DAYS * 86_400_000) return c.urls;
  }
  const base = `https://${host}`;
  const robots = (await get(`${base}/robots.txt`, f)) ?? '';
  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const roots = declared.length ? declared : [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];
  const urls = new Set<string>();
  const queue = [...roots];
  let read = 0;
  while (queue.length && read < MAX_CHILD_SITEMAPS + roots.length && urls.size < MAX_URLS) {
    const sm = queue.shift()!;
    const xml = await get(sm, f);
    read++;
    if (!xml) continue;
    const found = locs(xml);
    if (/<sitemapindex/i.test(xml)) queue.push(...found.sort((a, b) => childRank(a) - childRank(b)));
    else for (const u of found) if (urls.size < MAX_URLS) urls.add(u);
  }
  const list = [...urls];
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: now.toISOString(), urls: list }));
  return list;
}

const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['qual', 'quais', 'como', 'para', 'escolher', 'vale', 'pena', 'entre', 'diferenca', 'sobre', 'mais', 'melhor', 'tipo', 'tipos', 'cada', 'pelo', 'pela', 'segundo', 'fabricante', 'fabricantes', 'ficha', 'tecnica']);
export const phraseTerms = (texts: string[]) => texts.map((t) => norm(t).split(/[^a-z0-9]+/).filter(Boolean).join(' ')).filter((t) => t.includes(' '));
export const topicTerms = (texts: string[]) => [...new Set(texts.flatMap((t) => norm(t).split(/[^a-z0-9]+/)).filter((w) => w.length >= 4 && !STOP.has(w)))];

// Escolhe pelas palavras do endereço. Termo da pauta principal pesa mais; página de carrinho, conta, busca ou
// imagem não entra. Duas palavras em comum no mínimo (uma só, como "colchao", traria o catálogo inteiro).
export function rankUrls(urls: string[], primary: string[], extra: string[], n = 3): { url: string; matches: number; title: string }[] {
  const skip = /\/(cart|carrinho|checkout|conta|account|login|minha-conta|wishlist|busca|search|tag|author|autor|feed)(\/|$)|\.(jpg|jpeg|png|webp|gif|svg|mp4|zip)$/i;
  return urls
    .filter((u) => !skip.test(u))
    .map((u) => {
      let path = '';
      try {
        path = decodeURIComponent(new URL(u).pathname);
      } catch {
        return null;
      }
      const words = new Set(norm(path).split(/[^a-z0-9]+/).filter(Boolean));
      const flat = ` ${norm(path).split(/[^a-z0-9]+/).filter(Boolean).join(' ')} `;
      // Termo com espaço ("pillow top", termo do anúncio da pauta) casa como expressão inteira e vale por dois.
      const has = (t: string) => (t.includes(' ') ? flat.includes(` ${t} `) : words.has(t) || [...words].some((w) => w.length >= 5 && (w.startsWith(t) || t.startsWith(w))));
      const p = primary.reduce((n, t) => n + (has(t) ? (t.includes(' ') ? 2 : 1) : 0), 0);
      const x = extra.filter((t) => !primary.includes(t) && has(t)).length;
      return { url: u, matches: p + x, score: 2 * p + x, title: [...words].filter((w) => !/^\d+$/.test(w) && w !== 'html').join(' ') };
    })
    .filter((r): r is { url: string; matches: number; score: number; title: string } => !!r && r.matches >= 2 && r.score >= 3)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, n)
    .map(({ url, matches, title }) => ({ url, matches, title }));
}
