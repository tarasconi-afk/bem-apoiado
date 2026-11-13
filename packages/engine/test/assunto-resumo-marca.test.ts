import { describe, expect, it } from 'vitest';
import { assuntosDaPauta, escolherPorAssunto, impressaoDaPagina, resumoJaRecusado, type RecusaResumo } from '../src/stages/autopilot.ts';
import { BRAND_LISTING_TRIES, brandQueries, tentativasDaBuscaPorMarca } from '../src/stages/products.ts';

const KINDS = [
  { id: 'espuma', label: 'Colchão de espuma' },
  { id: 'molas_ensacadas', label: 'Colchão de molas ensacadas' },
  { id: 'jogo_de_cama', label: 'Lençol e jogo de cama' },
  { id: 'toalha', label: 'Toalha de banho' },
  { id: 'cobertor', label: 'Cobertor' },
  { id: 'outro', label: 'Outro' },
];

// 12-13/11: 3 ciclos seguidos em toalha ("toalha que enxuga melhor", "toalha que não solta pelo", "quando trocar a
// toalha") com pautas de outros produtos esperando na fila.
describe('assunto da pauta', () => {
  it('pelo tipo da pauta ou pelo nome do tipo na consulta', () => {
    expect(assuntosDaPauta('quando trocar a toalha', [], KINDS)).toEqual(['toalha']);
    expect(assuntosDaPauta('toalha que não solta pelo', ['toalha'], KINDS)).toEqual(['toalha']);
    expect(assuntosDaPauta('colchão de molas ensacadas ou bonnel', [], KINDS)).toEqual(['colchao']);
    expect(assuntosDaPauta('lençol com elástico: como escolher o tamanho', [], KINDS)).toEqual(['lencol']);
    // Sem tipo reconhecido: a primeira palavra de conteúdo.
    expect(assuntosDaPauta('como escolher roupão', [], KINDS)).toEqual(['roupao']);
  });

  const c = (query: string, assunto: string, retry = false) => ({ query, retry, assuntos: [assunto] });
  it('pula a pauta do mesmo assunto da anterior quando há outra', () => {
    const r = escolherPorAssunto([c('toalha que não solta pelo', 'toalha'), c('quando trocar a toalha', 'toalha'), c('cobertor ou manta', 'cobertor')], ['toalha']);
    expect(r).toEqual({ query: 'cobertor ou manta', adiada: 'toalha que não solta pelo' });
  });
  it('só do mesmo assunto: segue a ordem da fila', () => {
    expect(escolherPorAssunto([c('toalha que não solta pelo', 'toalha'), c('quando trocar a toalha', 'toalha')], ['toalha'])).toEqual({ query: 'toalha que não solta pelo', adiada: null });
  });
  it('pauta nova continua antes de nova tentativa, mesmo de assunto repetido', () => {
    expect(escolherPorAssunto([c('toalha que não solta pelo', 'toalha'), c('látex vale a pena', 'colchao', true)], ['toalha']).query).toBe('toalha que não solta pelo');
  });
  it('pauta retomada (pesquisa paga) mantém a vez mesmo de assunto repetido', () => {
    expect(escolherPorAssunto([{ ...c('toalha que não solta pelo', 'toalha'), retomada: true }, c('cobertor ou manta', 'cobertor')], ['toalha']).query).toBe('toalha que não solta pelo');
  });
  it('sem pauta anterior registrada: a primeira da fila', () => {
    expect(escolherPorAssunto([c('a', 'toalha'), c('b', 'cobertor')], []).query).toBe('a');
  });
});

describe('trava de retrabalho do resumo', () => {
  const page = { slug: 'pillow-top-o-que-e-e-vale-a-pena', title: 'Pillow top', description: 'd', verdict: 'v', sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'paragraph', text: 'x' }] }] } as never;
  it('mesma versão recusada não é tentada de novo; página mudada é', () => {
    const recusas: Record<string, RecusaResumo> = { 'pillow-top-o-que-e-e-vale-a-pena': { at: '2026-11-13T01:26:25Z', fp: impressaoDaPagina(page), motivo: 'repete a condição de como-decidir#1' } };
    expect(resumoJaRecusado(page, recusas)?.motivo).toMatch(/como-decidir#1/);
    const mudada = { ...(page as object), verdict: 'outro veredito' } as never;
    expect(resumoJaRecusado(mudada, recusas)).toBeNull();
    expect(resumoJaRecusado(page, {})).toBeNull();
  });
});

// 12/11 16h: "produtos para toalha-que-enxuga-melhor-como-escolher: 0 adicionado(s)" com 0 candidatos — a busca
// "Toalha de banho" devolve sobretudo páginas de busca/categoria da Amazon. A busca por marca do cadastro
// ("toalha de banho Karsten") devolveu 5 anúncios da marca em 13/11.
describe('busca de anúncio por marca do cadastro', () => {
  const makers = [
    { publisher: 'Karsten', kinds: ['jogo_de_cama', 'toalha'] },
    { publisher: 'Döhler', kinds: ['toalha'] },
    { publisher: 'Teka', kinds: ['toalha'] },
    { publisher: 'Probel', kinds: ['espuma'] },
    { publisher: 'Karsten', kinds: ['toalha'] },
  ];
  it('fabricantes do tipo, citados primeiro, sem a marca que a página já mostra', () => {
    expect(brandQueries('toalha', makers, new Set(['teka']), new Set(['döhler']), 2)).toEqual(['Döhler', 'Karsten']);
    expect(brandQueries('toalha', makers, new Set(), new Set(), 5)).toEqual(['Karsten', 'Döhler', 'Teka']);
    expect(brandQueries('espuma', makers, new Set(['probel']), new Set(), 2)).toEqual([]);
  });
});

describe('busca por marca tem cota própria (13/11, lençol)', () => {
  it('a busca pelo tipo que gastou todas as tentativas não impede a busca por marca', () => {
    expect(tentativasDaBuscaPorMarca(0)).toBe(BRAND_LISTING_TRIES);
    expect(tentativasDaBuscaPorMarca(7)).toBe(7);
  });
});
