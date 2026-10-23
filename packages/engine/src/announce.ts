import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, writeJson } from './store.ts';
import { hasKey, submitSitemap } from './gsc.ts';

// Aviso aos buscadores quando o site publica página nova ou atualizada (23/10, editor: "solicitar a indexação
// assim que a página for publicada"). Roda no sync, a cada 5 minutos: lê o sitemap do SITE NO AR (só avisa o
// que já está publicado) e compara com o último lido. O que mudou vai para o IndexNow (Bing, Yandex e as
// buscas por IA que usam o Bing) e o sitemap é reenviado ao Google pelo Search Console. A API de indexação
// do Google é só para vagas de emprego e transmissões ao vivo: não é usada.
// A chave do IndexNow é pública por definição do protocolo: o arquivo site/public/<chave>.txt prova o domínio.
export const INDEXNOW_KEY = '53dba958d5dc0ab0eef94784e63afcbb';
const SITE = process.env.BEM_SITE_URL ?? 'https://bemapoiado.com';
const STATE_FILE = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'announce.json');

export interface AnnounceState {
  urls: Record<string, string>; // loc → lastmod ('' sem lastmod) do último sitemap lido
  pending_indexnow: string[]; // mudou e o IndexNow ainda não aceitou (chave fora do ar, erro): tenta de novo
  pending_gsc: boolean;
  last?: { at: string; indexnow: string; gsc: string; sent: number };
}

export function parseSitemap(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(m[1]!)?.[1]?.trim();
    if (loc) out[loc] = /<lastmod>([^<]+)<\/lastmod>/.exec(m[1]!)?.[1]?.trim() ?? '';
  }
  return out;
}

export const changedUrls = (before: Record<string, string>, now: Record<string, string>) => Object.keys(now).filter((u) => before[u] !== now[u]);

export function loadAnnounce(): AnnounceState | null {
  return existsSync(STATE_FILE()) ? (JSON.parse(readFileSync(STATE_FILE(), 'utf8')) as AnnounceState) : null;
}

export async function announce(f: typeof fetch = fetch, now = new Date()): Promise<AnnounceState['last'] & { changed: number }> {
  const prev = loadAnnounce() ?? { urls: {}, pending_indexnow: [], pending_gsc: false };
  const sm = await f(`${SITE}/sitemap.xml`, { redirect: 'follow' });
  if (!sm.ok) throw new Error(`sitemap do site no ar: HTTP ${sm.status}`);
  const urls = parseSitemap(await sm.text());
  if (!Object.keys(urls).length) throw new Error('sitemap do site no ar sem URLs');
  const changed = changedUrls(prev.urls, urls);
  const pending = [...new Set([...prev.pending_indexnow, ...changed])].filter((u) => u in urls);
  let indexnow = 'nada novo';
  let left = pending;
  if (pending.length) {
    const host = new URL(SITE).host;
    const r = await f('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: pending.slice(0, 10_000) }),
    });
    // 200/202 = aceito. 403 = chave ainda não publicada no site; 422 = URL de outro domínio; 429 = volta depois.
    indexnow = r.ok ? `${pending.length} URL(s) aceitas (HTTP ${r.status})` : `recusado (HTTP ${r.status}); tenta no próximo sync`;
    if (r.ok) left = [];
  }
  let gsc = 'nada novo';
  let pendingGsc = prev.pending_gsc || changed.length > 0;
  if (pendingGsc && hasKey()) {
    try {
      const res = await submitSitemap(`${SITE}/sitemap.xml`, f);
      gsc = res === 'ok' ? 'sitemap reenviado' : 'sem permissão: a conta de serviço precisa de acesso "Completo" no Search Console';
      pendingGsc = false; // sem permissão não adianta repetir a cada 5 min; volta na próxima mudança
    } catch (e) {
      gsc = `falhou: ${(e as Error).message.slice(0, 120)}`;
    }
  } else if (pendingGsc) gsc = 'Search Console não conectado';
  const last = { at: now.toISOString(), indexnow, gsc, sent: pending.length - left.length };
  // Só registra o que mudou quando há o que contar: o painel mostra o último aviso de verdade.
  writeJson(STATE_FILE(), { urls, pending_indexnow: left, pending_gsc: pendingGsc, last: pending.length || changed.length ? last : prev.last } satisfies AnnounceState);
  return { ...last, changed: changed.length };
}
