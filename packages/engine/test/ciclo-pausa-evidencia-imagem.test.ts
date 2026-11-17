import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Melhorias autorizadas pelo dono em 16/11, a partir do fim de semana de 13–16/11.
const raiz = mkdtempSync(join(tmpdir(), 'bem-1611-'));
mkdirSync(join(raiz, 'data', 'images'), { recursive: true });
writeFileSync(join(raiz, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
process.env.BEM_ROOT = raiz;
process.env.BEM_STATE_DIR = join(raiz, '.state');

const auto = await import('../src/stages/autopilot.ts');
const { pausaHtml } = await import('../src/admin.ts');

describe('pausa de páginas novas com ramos esperando o dono', () => {
  it('conta ramos distintos e pausa a partir de 5', () => {
    expect(auto.pendentesNoAmbiente('a,b,a,,c')).toBe(3);
    expect(auto.pausaDePaginasNovas(4)).toBe(null);
    expect(auto.pausaDePaginasNovas(5)).toMatch(/^pausa de páginas novas: 5 ramos esperando você/);
    expect(auto.pausaDePaginasNovas(9)).toMatch(/só manutenção/);
  });
  it('o painel avisa por que o motor parou de abrir páginas', () => {
    expect(pausaHtml(3)).toBe('');
    expect(pausaHtml(9)).toContain('Pausa de páginas novas: 9 ramos esperando você');
  });
});

describe('pesquisa própria sem evidência não vai para a redação', () => {
  it('0 evidências aceitas para a pauta; qualquer evidência própria segue', () => {
    // 16/11, colchão de espuma para acampamento: discover 0, research 0, rascunho com 67% de enchimento (75,7 créditos).
    expect(auto.semEvidenciaPropria(0)).toBe(true);
    expect(auto.semEvidenciaPropria(1)).toBe(false);
  });
});

describe('imagem que falhou volta nos ciclos seguintes, com limite', () => {
  it('desiste só depois de 3 falhas na janela de 7 dias', () => {
    const agora = Date.parse('2026-11-16T12:00:00Z');
    const f = {
      a: { n: 1, at: '2026-11-15T12:00:00Z' },
      b: { n: 3, at: '2026-11-15T12:00:00Z' },
      c: { n: 3, at: '2026-11-01T12:00:00Z' }, // fora da janela: tenta de novo
    };
    expect(auto.imagensDesistidas(f, agora)).toEqual(['b']);
  });

  it('erro passageiro do provedor ganha segunda chance; erro definitivo não; nenhum derruba as outras', async () => {
    process.env.NEXOS_API_KEY = 'sk-teste-0000000000000000';
    const { ensureImages, imagemFalhaPassageira } = await import('../src/images.ts');
    expect(imagemFalhaPassageira(new Error('imagem x: HTTP 503 upstream connect error'))).toBe(true);
    expect(imagemFalhaPassageira(new Error('terminated'))).toBe(true);
    expect(imagemFalhaPassageira(new Error('imagem x: HTTP 400 bad prompt'))).toBe(false);

    const chamadas: string[] = [];
    const respostas: Record<string, number> = { 'pagina-a': 503, 'pagina-b': 400 };
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      const id = JSON.parse(init.body).prompt.startsWith('A') ? 'pagina-a' : 'pagina-b';
      chamadas.push(id);
      return new Response('falhou', { status: respostas[id]! });
    }) as unknown as typeof fetch;
    const falhas: string[] = [];
    const feitas = await ensureImages(
      raiz, [],
      [{ slug: 'a', title: 'Guia A', status: 'approved' }, { slug: 'b', title: 'Guia B', status: 'approved' }],
      async (s) => ({ alt: 'imagem de teste', prompt: (s.includes('Guia A') ? 'A' : 'B') + ' generic bedroom scene with soft daylight and wooden floor, wide shot' }),
      { fetchImpl, retryDelayMs: 0, onFail: (id) => falhas.push(id) },
    );
    expect(feitas).toEqual([]);
    expect(chamadas).toEqual(['pagina-a', 'pagina-a', 'pagina-b']); // 503 tentou 2x; 400 só 1x
    expect(falhas).toEqual(['pagina-a', 'pagina-b']);
    delete process.env.NEXOS_API_KEY;
  });
});

// 17/11: a pausa se realimentava (os ramos pagina/manutencao-* que ela gera contavam), o enriquecimento esperava por uma
// fila que não roda na pausa e o retrato page+query escondia páginas inteiras do passo de título/descrição.
describe('correções de 17/11', () => {
  it('ramo de manutenção não conta para a pausa; BEM_PENDING_PAGES vale no lugar de BEM_PENDING_SLUGS', () => {
    expect(auto.pendentesNoAmbiente('manutencao,a,b')).toBe(2);
    const antes = { s: process.env.BEM_PENDING_SLUGS, p: process.env.BEM_PENDING_PAGES };
    try {
      process.env.BEM_PENDING_SLUGS = 'a,b,c,d,e,manutencao';
      process.env.BEM_PENDING_PAGES = 'a,b';
      expect(auto.pendentesNoAmbiente()).toBe(2);
      expect(auto.pausaDePaginasNovas(auto.pendentesNoAmbiente())).toBe(null);
    } finally {
      if (antes.s === undefined) delete process.env.BEM_PENDING_SLUGS; else process.env.BEM_PENDING_SLUGS = antes.s;
      if (antes.p === undefined) delete process.env.BEM_PENDING_PAGES; else process.env.BEM_PENDING_PAGES = antes.p;
    }
  });
  it('o painel conta só página que o main ainda não tem e que o ramo traz', async () => {
    const { paginasNovasPendentes } = await import('../src/admin.ts');
    const pend = new Set(['manutencao', 'nova', 'no-ar', 'parada-sem-pagina']);
    expect(paginasNovasPendentes(pend, [{ slug: 'no-ar' }], new Set(['nova', 'no-ar']))).toBe(1);
  });
  it('totais por página do Search Console valem no lugar da soma das buscas', async () => {
    const { pageStats, snapshotTotals } = await import('../src/gsc.ts');
    const snap = {
      site: 'x', start: '2026-10-18', end: '2026-11-15', fetched_at: '2026-11-17T00:00:00Z',
      rows: [{ page: 'https://bemapoiado.com/a/', query: 'q', clicks: 0, impressions: 5, ctr: 0, position: 9 }],
      pages: [
        { page: 'https://bemapoiado.com/a/', clicks: 0, impressions: 40, ctr: 0, position: 8 },
        { page: 'https://bemapoiado.com/lencol-200-ou-400-fios-diferenca/', clicks: 0, impressions: 69, ctr: 0, position: 7.8 },
      ],
    };
    const st = pageStats(snap);
    expect(st.get('a')?.impressions).toBe(40);
    expect(st.get('a')?.queries).toHaveLength(1);
    expect(st.get('lencol-200-ou-400-fios-diferenca')?.impressions).toBe(69);
    expect(snapshotTotals(snap).impressions).toBe(109);
    const { pickSnippetPage } = await import('../src/stages/snippet.ts');
    const pg = (slug: string) => ({ slug, status: 'approved' }) as never;
    expect(pickSnippetPage(snap, [pg('a'), pg('lencol-200-ou-400-fios-diferenca')], {}, new Set())?.page.slug).toBe('lencol-200-ou-400-fios-diferenca');
  });
});
