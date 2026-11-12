import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.BEM_RETRY_MS = '0';
process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-snippet-'));
import { PageSpec } from '@bem-apoiado/core';
import type { GscSnapshot } from '../src/gsc.ts';
import type { FetchLike } from '../src/llm.ts';
import { readState, ROOT, writeState } from '../src/store.ts';
import { maintainSnippet, pickSnippetPage, SNIPPET_STATE, snippetIssues, type SnippetLog } from '../src/stages/snippet.ts';

const dir = join(ROOT, 'data/pages');
const base = PageSpec.parse(JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).status !== 'draft')!), 'utf8')));
const page = (slug: string, status: PageSpec['status'] = 'approved'): PageSpec => ({ ...base, slug, status });
const row = (slug: string, query: string, impressions: number, clicks: number, position: number) => ({ page: `https://bemapoiado.com/${slug}/`, query, impressions, clicks, ctr: clicks / impressions, position });
const snap = (rows: ReturnType<typeof row>[]): GscSnapshot => ({ site: 'x', start: '2026-10-12', end: '2026-11-09', fetched_at: '2026-11-11T00:00:00Z', rows });
const NOW = new Date('2026-11-12T12:00:00Z');

describe('título/descrição pelo Search Console: escolha', () => {
  const s = snap([
    row('a', 'nm', 236, 0, 9.8), row('a', 'o que significa nm', 600, 1, 5),
    row('b', 'b busca', 150, 0, 4), // elegível, menos impressões
    row('c', 'c busca', 99, 0, 3), // abaixo de 100 impressões
    row('d', 'd busca', 500, 1, 14), // posição > 10
    row('e', 'e busca', 300, 3, 5), // CTR = 1%
    row('f', 'f busca', 900, 0, 2), // rascunho
  ]);
  const pages = ['a', 'b', 'c', 'd', 'e'].map((x) => page(x)).concat(page('f', 'draft'));

  it('pega a de mais impressões entre ≥100 impressões, posição ≤10 e CTR <1%, só no ar', () => {
    expect(pickSnippetPage(s, pages, {}, new Set(), NOW)?.page.slug).toBe('a');
  });
  it('pula página com resultado pendente no quadro', () => {
    expect(pickSnippetPage(s, pages, {}, new Set(['a']), NOW)?.page.slug).toBe('b');
  });
  it('espera 14 dias depois da última reescrita da mesma página', () => {
    const log = (at: string): SnippetLog => ({ a: { at, run_id: 'r', period: '', before: { title: '', description: '', impressions: 0, clicks: 0, ctr: 0, position: 0 }, after: { title: '', description: '' } } });
    expect(pickSnippetPage(s, pages, log('2026-11-01T00:00:00Z'), new Set(), NOW)?.page.slug).toBe('b');
    expect(pickSnippetPage(s, pages, log('2026-10-28T00:00:00Z'), new Set(), NOW)?.page.slug).toBe('a');
  });
  it('nada elegível = nada', () => {
    expect(pickSnippetPage(snap([row('c', 'c', 99, 0, 3)]), pages, {}, new Set(), NOW)).toBeNull();
  });
});

describe('título/descrição: validação', () => {
  const p = { ...page('a'), title: 'Título atual da página de exemplo', description: 'Descrição atual com tamanho suficiente para passar no limite mínimo do schema.' };
  const ok = { title: 'O que significa isto: como comparar na ficha', description: 'Entenda o termo e veja o que conferir na ficha antes de comprar, com tabela de comparação.' };
  it('aceita proposta dentro dos limites', () => expect(snippetIssues(p, ok)).toEqual([]));
  it('barra título acima de 70 e descrição fora de 50–160', () => {
    expect(snippetIssues(p, { ...ok, title: 'x'.repeat(71) }).join()).toMatch(/título com 71/);
    expect(snippetIssues(p, { ...ok, description: 'curta demais' }).join()).toMatch(/descrição com/);
  });
  it('barra número que a página não tem, travessão, termo vetado e proposta igual', () => {
    expect(snippetIssues(p, { ...ok, title: 'Compare 987 modelos de verdade agora' }).join()).toMatch(/número que a página não tem: 987/);
    expect(snippetIssues(p, { ...ok, title: 'Como comparar — guia' }).join()).toMatch(/travessão/);
    expect(snippetIssues(p, ok, ['tabela']).join()).toMatch(/termo vetado/);
    expect(snippetIssues(p, { title: p.title, description: p.description }).join()).toMatch(/nada mudou/);
  });
});

describe('título/descrição: passo do ciclo', () => {
  beforeEach(() => {
    process.env.NEXOS_API_KEY = 'test-key';
    writeState(SNIPPET_STATE, {});
  });
  afterEach(() => delete process.env.NEXOS_API_KEY);

  it('nada elegível: passo registrado e nenhuma chamada', async () => {
    let calls = 0;
    const steps: string[] = [];
    const r = await maintainSnippet('run1', steps, { snapshot: snap([row('c', 'c', 99, 0, 3)]), pages: [page('c')], pending: new Set(), fetchImpl: async () => { calls++; return new Response('{}'); } });
    expect(r).toBe(false);
    expect(calls).toBe(0);
    expect(steps).toEqual(['Search Console: nenhuma página elegível para título/descrição']);
  });
  it('sem retrato do Search Console: mesmo passo, sem chamada', async () => {
    const steps: string[] = [];
    expect(await maintainSnippet('run1', steps, { snapshot: null })).toBe(false);
    expect(steps[0]).toMatch(/nenhuma página elegível/);
  });
  it('grava a proposta para o editor e registra os números de antes', async () => {
    const saved: PageSpec[] = [];
    const steps: string[] = [];
    const out = { title: 'O que significa isto: como comparar na ficha', description: 'Entenda o termo e veja o que conferir na ficha antes de comprar, com tabela de comparação.' };
    const f: FetchLike = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }), { status: 200 });
    const ok = await maintainSnippet('run2', steps, { snapshot: snap([row('a', 'o que significa', 790, 1, 6.7)]), pages: [page('a')], pending: new Set(), forbidden: [], fetchImpl: f, now: NOW, save: (p) => saved.push(p) });
    expect(ok).toBe(true);
    expect(saved[0]!.title).toBe(out.title);
    expect(saved[0]!.provenance.run_id).toMatch(/\+snippet:run2$/);
    expect(saved[0]!.sections).toEqual(base.sections);
    expect(steps[0]).toMatch(/título\/descrição de a reescritos pelo Search Console \(790 impressões, posição 6,7, CTR 0,1%\)/);
    const log = readState<SnippetLog>(SNIPPET_STATE, {});
    expect(log.a!.before.impressions).toBe(790);
    expect(log.a!.after.title).toBe(out.title);
  });
});
