import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { STATE_DIR } from './store.ts';

// Contador de visitas próprio, sem cookie e sem guardar IP. O site manda um aviso (navigator.sendBeacon)
// por página vista e por clique em link de afiliado; o visitante vira um código anônimo derivado de
// (sal do dia + IP + navegador), e o sal muda todo dia: não dá para seguir ninguém de um dia para o outro.
// Um arquivo por dia em STATE/hits/. Escuta em 127.0.0.1; o Caddy publica em t.bemapoiado.com/c.

const dir = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'hits');
const BOT = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime|curl|wget|python|node-fetch|axios|go-http/i;
const SITE = process.env.BEM_SITE_HOST ?? 'bemapoiado.com';

export interface Hit { t: string; e: 'pv' | 'aff'; p: string; a?: string; k?: 'produto' | 'busca'; r?: string; v: string }

function daySalt(day: string): string {
  const f = join(dir(), `.sal-${day}`);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  mkdirSync(dir(), { recursive: true });
  // Sal do dia anterior é apagado: o código do visitante de ontem não pode mais ser recalculado.
  for (const x of readdirSync(dir()).filter((n) => n.startsWith('.sal-') && n !== `.sal-${day}`)) writeFileSync(join(dir(), x), '');
  const s = randomBytes(16).toString('hex');
  writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export function toHit(body: unknown, ip: string, ua: string, now = new Date()): Hit | null {
  if (!ua || BOT.test(ua)) return null;
  const b = body as { e?: string; p?: string; a?: string; k?: string; r?: string };
  if (b?.e !== 'pv' && b?.e !== 'aff') return null;
  const p = String(b.p ?? '').slice(0, 200);
  if (!/^\/[a-z0-9/_-]*$/i.test(p)) return null;
  const day = now.toISOString().slice(0, 10);
  let r: string | undefined;
  try {
    const h = b.r ? new URL(String(b.r)).hostname.replace(/^www\./, '') : '';
    if (h && h !== SITE) r = h; // só a origem (google.com, instagram.com...), nunca o endereço completo
  } catch {
    /* referência inválida: ignora */
  }
  return {
    t: now.toISOString(), e: b.e, p,
    ...(b.e === 'aff' && /^[A-Z0-9]{10}$/.test(String(b.a)) ? { a: String(b.a) } : {}),
    ...(b.e === 'aff' && (b.k === 'produto' || b.k === 'busca') ? { k: b.k } : {}),
    ...(r ? { r } : {}),
    v: createHash('sha256').update(`${daySalt(day)}|${ip}|${ua}`).digest('hex').slice(0, 16),
  };
}

export function startHitsServer(port = Number(process.env.BEM_HITS_PORT ?? 8788)) {
  const perIp = new Map<string, number>();
  setInterval(() => perIp.clear(), 60_000).unref();
  createServer((req, res) => {
    const done = (code: number) => res.writeHead(code, { 'access-control-allow-origin': `https://${SITE}` }).end();
    if (req.method !== 'POST' || req.url !== '/c') return done(404);
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
    const n = (perIp.get(ip) ?? 0) + 1;
    perIp.set(ip, n);
    if (n > 60) return done(429);
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2000) req.destroy();
    });
    req.on('end', () => {
      try {
        const hit = toHit(JSON.parse(raw), ip, String(req.headers['user-agent'] ?? ''));
        if (hit) {
          mkdirSync(dir(), { recursive: true });
          appendFileSync(join(dir(), `${hit.t.slice(0, 10)}.jsonl`), JSON.stringify(hit) + '\n');
        }
      } catch {
        /* corpo inválido: ignora */
      }
      done(204);
    });
  }).listen(port, '127.0.0.1', () => console.log(`contador em 127.0.0.1:${port}`));
}

export interface PageTraffic { path: string; views: number; visitors: number; clicks: number; productClicks: number; searchClicks: number }

export function trafficSummary(days: number, now = new Date()): { views: number; visitors: number; clicks: number; productClicks: number; searchClicks: number; pages: PageTraffic[]; referrers: [string, number][] } {
  const pages = new Map<string, { views: number; v: Set<string>; clicks: number; prod: number; search: number }>();
  let productClicks = 0;
  let searchClicks = 0;
  const refs = new Map<string, number>();
  const visitors = new Set<string>();
  let views = 0;
  let clicks = 0;
  for (let i = 0; i < days; i++) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const f = join(dir(), `${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let h: Hit;
      try {
        h = JSON.parse(line);
      } catch {
        continue;
      }
      const p = pages.get(h.p) ?? { views: 0, v: new Set<string>(), clicks: 0, prod: 0, search: 0 };
      if (h.e === 'pv') {
        p.views++;
        views++;
        p.v.add(`${day}|${h.v}`);
        visitors.add(`${day}|${h.v}`);
        if (h.r) refs.set(h.r, (refs.get(h.r) ?? 0) + 1);
      } else {
        p.clicks++;
        clicks++;
        // Cliques antigos (sem "k") contam como produto: antes de 21/10 só havia cartões.
        if (h.k === 'busca') { p.search++; searchClicks++; } else { p.prod++; productClicks++; }
      }
      pages.set(h.p, p);
    }
  }
  return {
    views, visitors: visitors.size, clicks, productClicks, searchClicks,
    pages: [...pages].map(([path, x]) => ({ path, views: x.views, visitors: x.v.size, clicks: x.clicks, productClicks: x.prod, searchClicks: x.search })).sort((a, b) => b.views - a.views),
    referrers: [...refs].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

// Cliques na Amazon por produto (ASIN) nos últimos N dias: coluna da aba Produtos do painel.
export function clicksByAsin(days: number, now = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const f = join(dir(), `${new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const h = JSON.parse(line) as Hit;
        if (h.e === 'aff' && h.a) out.set(h.a, (out.get(h.a) ?? 0) + 1);
      } catch {
        /* linha inválida: ignora */
      }
    }
  }
  return out;
}
