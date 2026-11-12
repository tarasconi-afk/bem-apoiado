import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { firstForbidden, PageSpec } from '@bem-apoiado/core';
import { latestSnapshot, pageStats, type GscSnapshot, type PageStats } from '../gsc.ts';
import { callJson, creditsLeft, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { loadPages, PAGES_DIR, readState, ROOT, writeJson, writeState } from '../store.ts';
import { descriptionNumbers } from './page.ts';

// TÍTULO E DESCRIÇÃO PELO SEARCH CONSOLE (12/11/2026). Página que o Google já mostra no topo (posição média ≤ 10) e
// quase ninguém clica (CTR < 1% com ≥ 100 impressões em 4 semanas) perde o clique no resultado da busca, não no texto:
// o título não repete a pergunta que o leitor digitou nem diz o que a página entrega. Uma chamada barata reescreve SÓ
// título e descrição, com as buscas reais da página. Sem fato novo, sem número que a página não tenha. Sai como mudança
// de texto no resultado do ciclo, para o editor aprovar (cartão mostra "Título"/"Descrição" antes → depois).
// No máximo 1 página por ciclo e 1 vez a cada 14 dias por página; o registro guarda os números de antes para medir.

// 12/11: limiares do BA enquanto o site é novo (a página com mais impressões tinha 32, posição 13); com 100/10 o passo
// nunca rodaria por meses.
export const SNIPPET_MIN_IMPRESSIONS = 20;
export const SNIPPET_MAX_POSITION = 20;
export const SNIPPET_MAX_CTR = 0.01;
export const SNIPPET_INTERVAL_DAYS = 14;
export const SNIPPET_MIN_CREDITS = 2;
export const SNIPPET_STATE = 'snippet-gsc.json';
const TITLE = PageSpec.shape.title;
const DESCRIPTION = PageSpec.shape.description;

export interface SnippetEntry {
  at: string;
  run_id: string;
  period: string;
  before: { title: string; description: string; impressions: number; clicks: number; ctr: number; position: number };
  after: { title: string; description: string };
}
export type SnippetLog = Record<string, SnippetEntry>;

// Escolha determinística: a de mais impressões entre as elegíveis.
export function pickSnippetPage(snap: GscSnapshot, pages: PageSpec[], log: SnippetLog, pending: Set<string>, now = new Date()): { page: PageSpec; stats: PageStats } | null {
  const stats = pageStats(snap);
  const recent = (slug: string) => !!log[slug] && now.getTime() - Date.parse(log[slug]!.at) < SNIPPET_INTERVAL_DAYS * 86_400_000;
  const cands = pages
    .filter((p) => p.status !== 'draft' && !pending.has(p.slug) && !recent(p.slug))
    .map((p) => ({ page: p, stats: stats.get(p.slug) }))
    .filter((x): x is { page: PageSpec; stats: PageStats } => !!x.stats && x.stats.impressions >= SNIPPET_MIN_IMPRESSIONS && x.stats.position <= SNIPPET_MAX_POSITION && x.stats.ctr < SNIPPET_MAX_CTR)
    .sort((a, b) => b.stats.impressions - a.stats.impressions);
  return cands[0] ?? null;
}

// Páginas com resultado do motor ainda não aceito (ramo pagina/* fora do main que mexe nela): não mexe de novo.
export function pendingPageSlugs(): Set<string> {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const out = new Set<string>();
    for (const b of git('for-each-ref', '--no-merged=origin/main', '--format=%(refname:short)', 'refs/remotes/origin/pagina/').split('\n').filter(Boolean)) {
      for (const f of git('diff', '--name-only', `origin/main...${b}`, '--', 'data/pages').split('\n')) {
        const m = /^data\/pages\/(.+)\.json$/.exec(f);
        if (m) out.add(m[1]!);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

const pageText = (p: PageSpec) => [p.title, p.description, p.verdict.text, ...p.sections.flatMap((s) => [s.heading, ...s.blocks.map((b) => (b.kind === 'table' ? `${b.caption} ${b.columns.join(' ')} ${b.rows.map((r) => r.cells.map((c) => c.text).join(' ')).join(' ')}` : b.text))])].join('\n');

// O que barra a proposta: tamanho do schema, travessão, número que a página não tem, número da descrição fora do título
// (regra do site: descrição não passa pelo auditor), termo proibido do nicho, nada mudou.
export function snippetIssues(page: PageSpec, out: { title: string; description: string }, forbidden: string[] = []): string[] {
  const issues: string[] = [];
  if (!TITLE.safeParse(out.title).success) issues.push(`título com ${out.title.length} caracteres (limite ${TITLE.maxLength ?? 70})`);
  if (!DESCRIPTION.safeParse(out.description).success) issues.push(`descrição com ${out.description.length} caracteres (entre ${DESCRIPTION.minLength ?? 50} e ${DESCRIPTION.maxLength ?? 160})`);
  if (/—/.test(out.title + out.description)) issues.push('travessão (—)');
  const text = pageText(page);
  const nums = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const alien = [...new Set(nums(out.title + ' ' + out.description))].filter((n) => !text.includes(n));
  if (alien.length) issues.push(`número que a página não tem: ${alien.join(', ')}`);
  const dn = descriptionNumbers(out);
  if (dn.length) issues.push(`descrição com número fora do título: ${dn.join(', ')}`);
  const bad = firstForbidden(`${out.title} ${out.description}`, forbidden);
  if (bad) issues.push(`termo vetado: ${bad.term}`);
  if (out.title === page.title && out.description === page.description) issues.push('nada mudou');
  return issues;
}

export const SNIPPET_SYSTEM = `Você reescreve o título (aparece no Google, até 70 caracteres) e a descrição (até 160) de UMA página de um site de guias de compra em português do Brasil, para que quem busca clique. Não mexe no conteúdo da página.
Regras:
- O título começa pela pergunta ou pelo termo que o leitor mais digitou (veja as buscas), em palavras simples.
- Depois diz o que a página entrega de fato (comparação, tabela, o que conferir, como escolher), só se a página tiver isso.
- Nenhum fato, número, marca ou promessa que não esteja na página. Sem "melhor", "garantido", "definitivo", sem clickbait.
- Descrição: o que o leitor vai conseguir decidir ou conferir, sem número ou medida (a não ser que esteja no título).
- Sem travessão (—). Título entre 10 e 70 caracteres; descrição entre 50 e 160.
Responda só com JSON {"title": "...", "description": "..."}.`;

export function snippetPrompt(page: PageSpec, stats: PageStats): string {
  const queries = stats.queries.slice(0, 12).map((q) => `- "${q.query}" (${q.impressions} impressões, posição ${q.position.toFixed(1)})`).join('\n');
  const outline = page.sections.map((s) => `- ${s.heading}${s.blocks.some((b) => b.kind === 'table') ? ' (tem tabela)' : ''}`).join('\n');
  return `Página: /${page.slug}/
Título atual: ${page.title}
Descrição atual: ${page.description}
Resposta curta da página: ${page.verdict.text}
Seções:
${outline}

Search Console, últimas 4 semanas: ${stats.impressions} impressões, ${stats.clicks} cliques (CTR ${(stats.ctr * 100).toFixed(1)}%), posição média ${stats.position.toFixed(1)}.
Buscas que mostraram a página:
${queries}

Reescreva título e descrição.`;
}

const SnippetOut = z.object({ title: z.string(), description: z.string() });

export interface SnippetDeps {
  snapshot?: GscSnapshot | null;
  pages?: PageSpec[];
  pending?: Set<string>;
  forbidden?: string[];
  fetchImpl?: FetchLike;
  now?: Date;
  save?: (page: PageSpec) => void;
}

// Um passo do ciclo. Devolve true quando gravou mudança no repositório (o resultado do ciclo leva para o editor).
export async function maintainSnippet(runId: string, steps: string[], deps: SnippetDeps = {}): Promise<boolean> {
  const none = () => { steps.push('Search Console: nenhuma página elegível para título/descrição'); return false; };
  const snap = deps.snapshot === undefined ? latestSnapshot() : deps.snapshot;
  if (!snap || !snap.rows.length) return none();
  const log = readState<SnippetLog>(SNIPPET_STATE, {});
  const pick = pickSnippetPage(snap, deps.pages ?? loadPages(), log, deps.pending ?? pendingPageSlugs(), deps.now);
  if (!pick) return none();
  const { page, stats } = pick;
  const nums = `${stats.impressions} impressões, posição ${stats.position.toFixed(1).replace('.', ',')}, CTR ${(stats.ctr * 100).toFixed(1).replace('.', ',')}%`;
  if (creditsLeft() < SNIPPET_MIN_CREDITS) {
    steps.push(`título/descrição de ${page.slug}: adiado (orçamento do ciclo)`);
    return false;
  }
  // Marca a tentativa antes da chamada: falha ou proposta recusada também esperam 14 dias.
  const now = deps.now ?? new Date();
  const entry: SnippetEntry = { at: now.toISOString(), run_id: runId, period: `${snap.start}..${snap.end}`, before: { title: page.title, description: page.description, impressions: stats.impressions, clicks: stats.clicks, ctr: stats.ctr, position: stats.position }, after: { title: page.title, description: page.description } };
  writeState(SNIPPET_STATE, { ...log, [page.slug]: entry });
  try {
    const r = await callJson({ role: 'extractor', system: SNIPPET_SYSTEM, user: snippetPrompt(page, stats), schema: SnippetOut, schemaName: 'snippet', maxTokens: 400 }, deps.fetchImpl);
    const out = { title: r.data.title.trim(), description: r.data.description.trim() };
    const issues = snippetIssues(page, out, deps.forbidden ?? loadNiche().forbidden_terms);
    if (issues.length) {
      steps.push(`título/descrição de ${page.slug}: proposta descartada (${issues.join('; ')})`);
      return false;
    }
    const updated = PageSpec.parse({ ...page, title: out.title, description: out.description, updated_at: now.toISOString().slice(0, 10), provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+snippet:${runId}` } });
    (deps.save ?? ((p: PageSpec) => writeJson(join(PAGES_DIR, `${p.slug}.json`), p)))(updated);
    writeState(SNIPPET_STATE, { ...log, [page.slug]: { ...entry, after: out } });
    steps.push(`título/descrição de ${page.slug} reescritos pelo Search Console (${nums}); confira antes de aceitar`);
    return true;
  } catch (e) {
    steps.push(`título/descrição de ${page.slug}: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}
