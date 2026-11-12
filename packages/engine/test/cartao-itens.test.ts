import { describe, expect, it } from 'vitest';
import { cardSubject, costLine, costSummary, learningLine, textHint, whatBlock, type CartaoCtx } from '../src/cartao.ts';
import { describeChanges, exclusionOps, type ChangeItem, type Read } from '../src/changes.ts';

// 29/10: "home" e "theme" sumiam do formulário e o motor os registrava como recusados (o que não vem no formulário
// é recusa). 12/11: links, botões de busca e modelos citados iam escondidos e o editor aplicava sem vê-los; capa e
// foto de produto eram uma caixa só. Regra de agora: UMA linha visível e UMA caixa por item, sempre.

const TITULOS: Record<string, string> = {
  'travesseiro-de-pena-de-ganso-ou-de-fibra': 'Travesseiro de pena de ganso ou de fibra',
  'protetor-de-colchao-vale-a-pena': 'Protetor de colchão vale a pena?',
  'colchao-d33-suporta-quantos-kg': 'Colchão D33 suporta quantos kg?',
};
const ctx = (over: Partial<CartaoCtx> = {}): CartaoCtx => ({
  titleOf: (s) => TITULOS[s] ?? s,
  pageFor: (k) => (k === 'protetor' ? 'protetor-de-colchao-vale-a-pena' : undefined),
  prev: (p, l) => `<a href="/previa/${p}">${l}</a>`,
  imgUrl: (x) => `/imagem?ramo=r&arquivo=${x}`,
  imgMainUrl: (x) => `/imagem?ramo=main&arquivo=${x}`,
  ...over,
});

// O cartão "Capa nova: Travesseiro…" de 12/11 (ciclo das 04:12), com a foto do produto separada.
const ITENS: ChangeItem[] = [
  { id: 'cited', title: 'Modelos citados', paths: ['data/cited-models.json'], per: [{ slug: 'colchao-d33-suporta-quantos-kg', values: ['Probel Guarda Costas', 'Ortobom Pró Saúde Extra'], had: 0 }] },
  { id: 'anchors', title: 'Links internos no texto', paths: ['data/link-anchors.json'], per: [{ slug: 'colchao-d33-suporta-quantos-kg', values: ['peso suportado colchão', 'densidade d33'], had: 1 }] },
  { id: 'product:B07GB3BD1N', title: 'Novo exemplo à venda: Ruili Protetor de colchão', detail: 'só anúncio (sem ficha do fabricante) · marca "Ruili"', paths: ['data/products/B07GB3BD1N.json'], asin: 'B07GB3BD1N', kind: 'protetor' },
  { id: 'image:pagina-travesseiro-de-pena-de-ganso-ou-de-fibra.webp', title: 'Imagem', paths: ['site/src/assets/generated/pagina-travesseiro-de-pena-de-ganso-ou-de-fibra.webp'], replaces: false },
  { id: 'image:produto-b07gb3bd1n.webp', title: 'Imagem', paths: ['site/src/assets/generated/produto-b07gb3bd1n.webp'], replaces: false },
];
const caixas = (html: string, id: string) => html.split(`name="manter" value="${id}"`).length - 1;

describe('cartão: o que entra no site', () => {
  it('todo item tem exatamente uma caixa, inclusive os que iam escondidos', () => {
    const extra: ChangeItem[] = [
      { id: 'search-links', title: 'Buscas', paths: ['data/search-links.json'], per: [{ slug: 'colchao-d33-suporta-quantos-kg', values: ['Colchão D33 para 71 a 80 kg', 'Colchão D45 acima de 100 kg', 'Colchão misto'], had: 0 }] },
      { id: 'theme', title: 'Visual do site (tema)', paths: ['data/theme.json'] },
      { id: 'home', title: 'Ordem dos guias na home', paths: ['data/home-order.json'] },
      { id: 'niche', title: 'Tipo de produto novo: Protetor', paths: ['data/niche.json'] },
      { id: 'other:data/x.json', title: 'Outra mudança: data/x.json', paths: ['data/x.json'] },
      { id: 'page:colchao-d33-suporta-quantos-kg', title: 'Texto de "Colchão D33": 2 trecho(s) alterado(s)', paths: ['data/pages/colchao-d33-suporta-quantos-kg.json'], slug: 'colchao-d33-suporta-quantos-kg', diffs: [{ where: 'Título', before: 'a', after: 'b' }, { where: 'Descrição', before: 'c', after: 'd' }] },
    ];
    const html = whatBlock([...ITENS, ...extra], ctx());
    for (const it of [...ITENS, ...extra]) expect(caixas(html, it.id), it.id).toBe(1);
    expect(html).toContain('O que entra no site (11)');
    expect(html).toContain('ganha 3 botões "buscar na Amazon"');
    expect(html).toContain('viram link "Ver na Amazon": Probel Guarda Costas, Ortobom Pró Saúde Extra');
    expect(html).toContain('<q>peso suportado colchão</q> e <q>densidade d33</q> passam a levar para');
    expect(html).toContain('Exemplo à venda novo em <span class="pg">Protetor de colchão vale a pena?</span>');
    expect(html).toContain('da ilustração genérica para uma capa própria');
    expect(html).toContain('Foto do exemplo à venda Ruili Protetor de colchão');
  });

  it('o texto da página do próprio cartão entra sempre (sem caixa para desmarcar)', () => {
    const own: ChangeItem = { id: 'page:x', title: 'Página nova no ar: X', paths: ['data/pages/x.json'], slug: 'x' };
    const html = whatBlock([own, ITENS[0]!], ctx({ ownSlug: 'x' }));
    expect(html).toContain('<input type="hidden" name="manter" value="page:x">');
    expect(html).toContain('<input type="checkbox" name="manter" value="cited"');
  });

  it('troca de capa mostra a imagem de hoje e a nova', () => {
    const html = whatBlock([{ ...ITENS[3]!, replaces: true }], ctx());
    expect(html).toContain('ramo=main');
    expect(html).toContain('trocada por uma nova');
  });

  it('título: página principal (a da capa) + quantas outras + quantas mudanças', () => {
    expect(cardSubject(ITENS, ctx())).toBe('Travesseiro de pena de ganso ou de fibra e mais 2 páginas: 5 mudanças');
    expect(cardSubject(ITENS.slice(0, 2), ctx())).toBe('Colchão D33 suporta quantos kg?: 2 mudanças');
    expect(cardSubject([{ id: 'theme', title: 'Tema', paths: ['data/theme.json'] }], ctx())).toBe('Site todo: 1 mudança');
  });

  it('custo diz onde os créditos foram e que aplicar não gasta', () => {
    expect(costLine(76.5, 'colchão ou cama box', 'virou rascunho: a revisão achou…', 'manutencao')).toContain('o ciclo gastou ~76,5 créditos, quase tudo na pauta nova "colchão ou cama box" (virou rascunho). <b>Aplicar não gasta créditos.</b>');
    expect(costLine(30, undefined, null, 'pagina-nova')).toContain('o ciclo gastou ~30,0 créditos. <b>Publicar não gasta créditos.</b>');
    expect(costLine(null, 'x', null, 'manutencao')).toBe('');
    expect(costSummary(76.5)).toBe(' · ciclo custou ~76,5 créditos');
  });

  it('aprendizado e dica de onde corrigir o texto', () => {
    expect(learningLine(['rascunho de "Quando trocar o colchão" (não vai ao ar)', '15 fonte(s) nova(s) arquivada(s)'])).toContain('Não muda o site, entra junto:</b> rascunho de &quot;Quando trocar o colchão&quot;');
    expect(textHint(ITENS, 'Travesseiro de pena de ganso ou de fibra', 'aba Páginas')).toContain('não mexe no texto de Travesseiro');
    expect(textHint([...ITENS, { id: 'page:y', title: 't', paths: [] }], 'T', 'x')).toBe('');
  });
});

describe('uma caixa por imagem, com registro coerente', () => {
  const reg = (ids: string[]) => JSON.stringify(ids.map((id) => ({ id, file: `site/src/assets/generated/${id}.webp`, alt: id })));
  const files = [
    { status: 'A' as const, path: 'site/src/assets/generated/pagina-travesseiro.webp' },
    { status: 'A' as const, path: 'site/src/assets/generated/produto-b07gb3bd1n.webp' },
    { status: 'M' as const, path: 'data/images/registry.json' },
    { status: 'M' as const, path: 'data/images/briefs.json' },
  ];
  const main: Record<string, string> = { 'data/images/registry.json': reg(['antiga']), 'data/images/briefs.json': reg(['antiga']) };
  const branch: Record<string, string> = { 'data/images/registry.json': reg(['antiga', 'pagina-travesseiro', 'produto-b07gb3bd1n']), 'data/images/briefs.json': reg(['antiga', 'pagina-travesseiro', 'produto-b07gb3bd1n']) };
  const rm: Read = (p) => main[p] ?? null;
  const rb: Read = (p) => branch[p] ?? null;

  it('cada .webp vira um item; os json não são item', () => {
    const s = describeChanges(files, rm, rb);
    expect(s.items.map((i) => i.id)).toEqual(['image:pagina-travesseiro.webp', 'image:produto-b07gb3bd1n.webp']);
    expect(s.items.every((i) => i.replaces === false)).toBe(true);
  });

  it('recusar uma imagem tira só a entrada dela do registro e dos briefs', () => {
    const s = describeChanges(files, rm, rb);
    const ops = exclusionOps(s, ['image:pagina-travesseiro.webp'], rm, rb);
    expect(ops.find((o) => o.path.endsWith('.webp'))).toEqual({ path: 'site/src/assets/generated/pagina-travesseiro.webp', content: null });
    for (const j of ['data/images/registry.json', 'data/images/briefs.json']) expect(JSON.parse(ops.find((o) => o.path === j)!.content!).map((r: { id: string }) => r.id)).toEqual(['antiga', 'produto-b07gb3bd1n']);
  });

  it('id antigo "images" (formulário de antes de 12/11) recusa todas as imagens', () => {
    const s = describeChanges(files, rm, rb);
    const ops = exclusionOps(s, ['images'], rm, rb);
    expect(ops.filter((o) => o.path.endsWith('.webp')).length).toBe(2);
    expect(JSON.parse(ops.find((o) => o.path === 'data/images/registry.json')!.content!).map((r: { id: string }) => r.id)).toEqual(['antiga']);
  });

  it('troca recusada devolve a entrada antiga do main; entradas mescladas depois ficam', () => {
    const files2 = [{ status: 'M' as const, path: 'site/src/assets/generated/antiga.webp' }];
    const mainR: Read = (p) => (p.endsWith('.webp') ? 'bin' : JSON.stringify([{ id: 'antiga', alt: 'velha' }]));
    const branchR: Read = (p) => (p.endsWith('.webp') ? 'bin2' : JSON.stringify([{ id: 'antiga', alt: 'nova' }]));
    const nowR: Read = (p) => (p.endsWith('.webp') ? 'bin2' : JSON.stringify([{ id: 'antiga', alt: 'nova' }, { id: 'outra', alt: 'de outro resultado' }]));
    const s = describeChanges(files2, mainR, branchR);
    expect(s.items[0]).toMatchObject({ id: 'image:antiga.webp', replaces: true });
    const ops = exclusionOps(s, ['image:antiga.webp'], mainR, branchR, nowR);
    expect(JSON.parse(ops.find((o) => o.path === 'data/images/registry.json')!.content!)).toEqual([{ id: 'antiga', alt: 'velha' }, { id: 'outra', alt: 'de outro resultado' }]);
  });
});

describe('capa de página nova', () => {
  it('não diz "trocada" quando a página ainda não está no ar', () => {
    const html = whatBlock([ITENS[3]!], ctx({ isLive: () => false }));
    expect(html).toContain('Capa da página nova');
    expect(html).not.toContain('ilustração genérica');
  });
});
