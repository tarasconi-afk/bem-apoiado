import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PageSpec, Product } from '@bem-apoiado/core';
import { ROOT } from './store.ts';

// O que um resultado do motor (ramo pagina/*) muda, em linguagem de editor. Mudança PÚBLICA (o leitor vê:
// texto de página no ar, página nova, produto, tema, imagem, links, ordem da home) pede decisão, item por
// item; o resto é aprendizado (fontes, evidências, pautas, rascunhos, registros) e entra sozinho.
// O id de cada item é estável: o painel mostra, o editor desmarca, e applyExclusions desfaz só aquele item.

export interface FileChange { status: 'A' | 'M' | 'D'; path: string }
export type Read = (path: string) => string | null;
export interface ChangeItem { id: string; title: string; detail?: string; diffs?: { where: string; before: string; after: string }[]; paths: string[]; slug?: string; asin?: string; kind?: string }
export interface ChangeSummary { items: ChangeItem[]; learning: string[] }

const parse = <T>(raw: string | null, f: (v: unknown) => T): T | null => {
  if (raw === null) return null;
  try {
    return f(JSON.parse(raw));
  } catch {
    return null;
  }
};
const live = (p: PageSpec | null) => !!p && p.status !== 'draft';

function blockTexts(p: PageSpec): Map<string, { where: string; text: string }> {
  const m = new Map<string, { where: string; text: string }>([
    ['title', { where: 'Título', text: p.title }],
    ['description', { where: 'Descrição', text: p.description }],
    ['verdict', { where: 'Resposta curta', text: p.verdict.text }],
  ]);
  for (const s of p.sections) {
    s.blocks.forEach((b, i) => {
      const text = b.kind === 'table' ? `${b.caption} · ${b.rows.map((r) => r.cells.map((c) => c.text).join(' | ')).join(' / ')}` : b.text;
      m.set(`${s.id}#${i}`, { where: `${s.heading} · ${b.kind === 'table' ? 'tabela' : `bloco ${i + 1}`}`, text });
    });
  }
  return m;
}

export function textDiffs(before: PageSpec, after: PageSpec): { where: string; before: string; after: string }[] {
  const a = blockTexts(before);
  const b = blockTexts(after);
  const out: { where: string; before: string; after: string }[] = [];
  // Bloco ou tabela que só mudou de lugar: "movido", não "removido" + "novo" (22/10: mover a tabela de tamanhos
  // para o Como decidir aparecia como 6 trechos alterados).
  const posOf = (m: typeof a, text: string) => [...m].find(([, v]) => v.text === text)?.[0];
  const moved = new Set<string>();
  for (const [k, v] of b) {
    const from = posOf(a, v.text);
    if (from && from !== k && !['title', 'description', 'verdict'].includes(k)) {
      const sec = (key: string, m: typeof a) => m.get(key)!.where.split(' · ')[0];
      if (sec(from, a) !== sec(k, b)) out.push({ where: v.where.includes('· tabela') ? 'Tabela movida' : 'Bloco movido', before: `em "${sec(from, a)}"`, after: `em "${sec(k, b)}"` });
      moved.add(v.text);
    }
  }
  for (const [k, v] of b) if (a.get(k)?.text !== v.text && !moved.has(v.text)) out.push({ where: v.where, before: a.get(k)?.text ?? '(novo)', after: v.text });
  for (const [k, v] of a) if (!b.has(k) && ![...b.values()].some((x) => x.text === v.text)) out.push({ where: v.where, before: v.text, after: '(removido)' });
  return out;
}

const LEARNING = [/^data\/(sources|claims|runs|topics|feedback|proposals)\//, /^data\/(queue|ideas|topic-variants|dev-requests)\.json$/, /^data\/registry\//];

export function describeChanges(files: FileChange[], readMain: Read, readBranch: Read): ChangeSummary {
  const items: ChangeItem[] = [];
  const learning: string[] = [];
  const count = { sources: 0, claims: 0, topics: 0, runs: new Set<string>(), other: 0 };
  const byAsin = new Map<string, ChangeItem>();
  const images: string[] = [];
  for (const f of files) {
    const page = /^data\/pages\/([^/]+)\.json$/.exec(f.path);
    const prod = /^data\/products\/([A-Z0-9]{10})\.json$/.exec(f.path);
    const retired = /^data\/products-retired\/([A-Z0-9]{10})\.json$/.exec(f.path);
    if (page) {
      const slug = page[1]!;
      const before = parse(readMain(f.path), (v) => PageSpec.parse(v));
      const after = parse(readBranch(f.path), (v) => PageSpec.parse(v));
      if (!live(before) && !live(after)) {
        learning.push(`rascunho de "${(after ?? before)?.title ?? slug}" (não vai ao ar)`);
      } else if (!live(before)) {
        items.push({ id: `page:${slug}`, title: `Página nova no ar: ${after!.title}`, paths: [f.path], slug });
      } else if (!after) {
        items.push({ id: `page:${slug}`, title: `Página sai do ar: ${before!.title}`, paths: [f.path] });
      } else {
        const diffs = textDiffs(before!, after);
        const out = !live(after);
        if (!diffs.length && !out) continue;
        items.push({ id: `page:${slug}`, title: out ? `Página volta a rascunho (sai do ar): ${before!.title}` : `Texto de "${after.title}": ${diffs.length} trecho(s) alterado(s)`, diffs, paths: [f.path], slug });
      }
    } else if (prod || retired) {
      const asin = (prod ?? retired)![1]!;
      const it = byAsin.get(asin) ?? { id: `product:${asin}`, title: '', paths: [], asin };
      it.paths.push(f.path);
      byAsin.set(asin, it);
    } else if (f.path === 'data/theme.json') {
      const a = readMain(f.path) ?? '{}';
      const b = readBranch(f.path) ?? '{}';
      items.push({ id: 'theme', title: 'Visual do site (tema)', detail: themeDiff(JSON.parse(a), JSON.parse(b)), paths: [f.path] });
    } else if (f.path === 'data/link-anchors.json') {
      const a = parse(readMain(f.path), (v) => v as { pages: Record<string, { anchors: string[] }> })?.pages ?? {};
      const b = parse(readBranch(f.path), (v) => v as { pages: Record<string, { anchors: string[] }> })?.pages ?? {};
      const changed = Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      items.push({ id: 'anchors', title: 'Links internos no texto', detail: changed.map((k) => `${k}: ${b[k]!.anchors.join(', ')}`).join(' · '), paths: [f.path] });
    } else if (f.path === 'data/search-links.json') {
      const a = parse(readMain(f.path), (v) => v as { pages: Record<string, { links: { label: string; query: string }[] }> })?.pages ?? {};
      const b = parse(readBranch(f.path), (v) => v as { pages: Record<string, { links: { label: string; query: string }[] }> })?.pages ?? {};
      const changed = Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      items.push({ id: 'search-links', title: 'Buscas na Amazon (links com a nossa tag)', detail: changed.map((k) => `${k}: ${b[k]!.links.map((l) => `"${l.label}" (${l.query})`).join(', ')}`).join(' · '), paths: [f.path] });
    } else if (f.path === 'data/niche.json') {
      // Tipo de produto novo (Pedir ao motor): diz qual, em vez de "Outra mudança: data/niche.json".
      const kinds = (r: string | null) => parse(r, (v) => (v as { product_kinds: { id: string; label: string; accessory?: boolean }[] }).product_kinds) ?? [];
      const was = new Set(kinds(readMain(f.path)).map((k) => k.id));
      const added = kinds(readBranch(f.path)).filter((k) => !was.has(k.id));
      items.push({ id: 'niche', title: added.length ? `Tipo de produto novo: ${added.map((k) => `${k.label}${k.accessory ? ' (acessório, vendido avulso)' : ''}`).join(', ')}` : 'Perfil do site (nicho)', paths: [f.path] });
    } else if (f.path === 'data/home-order.json') {
      items.push({ id: 'home', title: 'Ordem dos guias na home (dados do Google)', paths: [f.path] });
    } else if (f.path.startsWith('site/src/assets/generated/') || f.path.startsWith('data/images/')) {
      images.push(f.path);
    } else if (/^data\/sources\/[^/]+\/meta\.json$/.test(f.path) && f.status === 'A') count.sources++;
    else if (/^data\/claims\//.test(f.path)) count.claims++;
    else if (/^data\/topics\//.test(f.path)) count.topics++;
    else if (/^data\/runs\//.test(f.path)) count.runs.add(f.path.split('/')[2]!);
    else if (LEARNING.some((re) => re.test(f.path))) count.other++;
    else items.push({ id: `other:${f.path}`, title: `Outra mudança: ${f.path}`, paths: [f.path] });
  }
  for (const it of byAsin.values()) {
    const p = it.paths.find((x) => x.startsWith('data/products/'));
    const before = p ? parse(readMain(p), (v) => Product.parse(v)) : null;
    const after = p ? parse(readBranch(p), (v) => Product.parse(v)) : null;
    const r = it.paths.find((x) => x.startsWith('data/products-retired/'));
    const why = r ? parse(readBranch(r), (v) => (v as { reason?: string }).reason ?? '') : null;
    if (after && !before) {
      it.title = `Novo exemplo à venda: ${after.label}`;
      it.kind = after.kind;
      it.detail = `${after.evidence === 'editor' ? 'escolhido pelo editor' : after.evidence === 'listing' ? 'só anúncio (sem ficha do fabricante)' : 'com ficha do fabricante'} · marca "${after.brand}" · aparece nas páginas com o tipo "${after.kind}"`;
    } else if (before && !after) {
      it.title = `Exemplo retirado: ${before.label}`;
      it.detail = why ? `motivo: ${why}` : undefined;
    } else if (before && after) {
      // Renovação da disponibilidade (data conferida): rotina, não pede decisão.
      learning.push(`disponibilidade de ${after.label} conferida de novo`);
      it.paths.length = 0;
      continue;
    } else continue;
    items.push(it);
  }
  // Capa de página nova (pagina-<slug>) vai junto do item da própria página: aceitar a página sem a capa,
  // ou a capa sem a página, não faz sentido. Imagem de tipo de produto continua item próprio.
  const files_ = images.filter((x) => !x.endsWith('.json'));
  const pageOf = (x: string) => items.find((i) => i.slug && i.id === `page:${i.slug}` && x.includes(`pagina-${i.slug}.`));
  if (files_.length && files_.every(pageOf)) {
    for (const x of images) (pageOf(x) ?? pageOf(files_[0]!))!.paths.push(x);
    for (const i of new Set(files_.map(pageOf))) i!.detail = [i!.detail, 'inclui a imagem de capa nova (miniatura abaixo)'].filter(Boolean).join(' · ');
  } else if (images.length) items.push({ id: 'images', title: `Imagens novas (${files_.length})`, paths: images });
  if (count.sources) learning.push(`${count.sources} fonte(s) nova(s) arquivada(s)`);
  if (count.claims) learning.push(`${count.claims} evidência(s) nova(s) ou ligada(s) a pautas`);
  if (count.topics) learning.push(`${count.topics} pauta(s) criada(s) ou atualizada(s)`);
  if (count.runs.size) learning.push(`registro de ${count.runs.size} execução(ões)`);
  if (count.other) learning.push(`${count.other} arquivo(s) de fila, ideias ou cadastro`);
  return { items: items.filter((i) => i.paths.length), learning };
}

function themeDiff(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): string {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a?.[k];
    const y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object') out.push(themeDiff(x as Record<string, unknown>, y as Record<string, unknown>, `${prefix}${k}.`));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${prefix}${k}: ${JSON.stringify(x ?? 'padrão')} → ${JSON.stringify(y)}`);
  }
  return out.filter(Boolean).join(' · ');
}

// Como terminou a tentativa de página, para quem não conhece o motor (etapas do commit do ciclo).
export function plainOutcome(steps: string[]): string | null {
  const page = steps.find((s) => s.startsWith('page: '));
  const research = /^research: (\d+) evidências/.exec(steps.find((s) => s.startsWith('research: ')) ?? '');
  if (steps.includes('sem fontes aceitas')) return 'não virou página: nenhuma fonte confiável do cadastro foi encontrada para o tema';
  // Checagem antes da redação (22/10): sem página, sem prévia; o editor não entendia por que não havia o que ver.
  const deferred = steps.find((s) => s.startsWith('pauta adiada antes da redação'));
  if (deferred) {
    const why = /\((.+)\)\s*$/.exec(deferred)?.[1] ?? 'as evidências não dizem o que escolher';
    return `não virou página, por isso não há prévia: antes de escrever, o motor viu que as fontes encontradas não dizem ao leitor o que escolher. Falta: ${why.slice(0, 220)}. Nada foi gasto em redação. Próxima vez que a pauta for a da vez, ele busca isso de novo; se não quiser esperar, tire a pauta da fila ou indique um fabricante que tenha essa informação`;
  }
  // Nova tentativa de pauta já pesquisada (improve): o desfecho vem numa linha "improve: …".
  const imp = steps.find((s) => s.startsWith('improve: '));
  if (!page && imp) {
    if (/página PASS/.test(imp)) return 'virou página aprovada pela auditoria e pela revisão';
    if (/página NOT_PUBLISHABLE/.test(imp)) return 'virou rascunho: a revisão achou a página fraca; ela aparece num cartão "Rascunho para seu veredito" para você decidir';
    if (/página SAFE_STOP/.test(imp)) return 'não virou página: na nova tentativa, o auditor ainda achou afirmações sem fonte que o redator não conseguiu corrigir; o que ele recusou fica anotado para a próxima';
    if (/NO_NEW_SOURCES/.test(imp)) return 'não virou página: a busca dirigida ao que faltava não achou fonte nova confiável; a pauta espera fonte nova (ou um fabricante que você indicar)';
    if (/NO_NEW_EVIDENCE/.test(imp)) return 'não virou página: as fontes novas não tinham trecho que respondesse ao que faltava';
    if (/IMPROVE_LIMIT/.test(imp)) return 'não virou página: a pauta já teve todas as tentativas; ela só volta se você pedir';
    if (/NOT_READY/.test(imp)) return 'não virou página, por isso não há prévia: antes de escrever, o motor viu que as fontes ainda não dizem ao leitor o que escolher; ele tenta de novo em 3 dias';
  }
  if (!page) return null;
  if (page.startsWith('page: PASS')) return 'virou página aprovada pela auditoria e pela revisão';
  if (page.startsWith('page: NOT_PUBLISHABLE')) return 'virou rascunho: a revisão achou a página fraca; ela aparece em "Páginas: seu veredito" para você decidir';
  if ((research && research[1] === '0') || /INSUFFICIENT_EVIDENCE/.test(page)) return `não virou página: as fontes encontradas não responderam às perguntas da pauta (${research?.[1] ?? 'poucas'} evidências); o motor tenta de novo com outras buscas`;
  if (/AUDIT_NOT_CONVERGED/.test(page)) return 'não virou página: o auditor achou afirmações sem fonte que o redator não conseguiu corrigir em 3 voltas';
  if (page.startsWith('page: SAFE_STOP')) return 'não virou página: o motor parou por segurança antes de publicar algo sem fonte';
  return null;
}

// Desfaz no repositório (já mesclado) só os itens recusados: o arquivo volta à versão do main, ou sai se
// for novo. Produto recusado vai para products-retired/, para a busca não trazê-lo de volta.
export function exclusionOps(summary: ChangeSummary, excluded: string[], readMain: Read, readBranch: Read): { path: string; content: string | null }[] {
  const ops: { path: string; content: string | null }[] = [];
  for (const it of summary.items.filter((i) => excluded.includes(i.id))) {
    for (const p of it.paths) ops.push({ path: p, content: readMain(p) });
    if (it.asin && it.title.startsWith('Novo exemplo')) {
      const raw = readBranch(`data/products/${it.asin}.json`);
      if (raw) ops.push({ path: `data/products-retired/${it.asin}.json`, content: JSON.stringify({ ...JSON.parse(raw), retired_at: new Date().toISOString(), reason: 'recusado pelo editor no painel' }, null, 2) + '\n' });
    }
  }
  return ops;
}

// Leitura pelo git: o que o ramo mudou desde que saiu do main (três pontos = só o lado do ramo).
export function gitChanges(ref: string, base = 'origin/main'): { summary: ChangeSummary; readMain: Read; readBranch: Read } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  const show = (rev: string): Read => (path) => {
    try {
      return git('show', `${rev}:${path}`);
    } catch {
      return null;
    }
  };
  const files = git('diff', '--name-status', '--no-renames', `${base}...${ref}`).split('\n').filter(Boolean).map((l) => {
    const [st, path] = l.split('\t');
    return { status: (st![0] === 'A' ? 'A' : st![0] === 'D' ? 'D' : 'M') as FileChange['status'], path: path! };
  });
  const readMain = show(base);
  const readBranch = show(ref);
  return { summary: describeChanges(files, readMain, readBranch), readMain, readBranch };
}

export function applyExclusions(ref: string, excluded: string[]): string[] {
  const { summary, readMain, readBranch } = gitChanges(ref);
  const ops = exclusionOps(summary, excluded, readMain, readBranch);
  for (const op of ops) {
    const abs = join(ROOT, op.path);
    if (op.content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, op.content);
    }
  }
  return summary.items.filter((i) => excluded.includes(i.id)).map((i) => i.title);
}
