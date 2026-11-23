// BLACK FRIDAY 2026 (23/11, pedido do dono). Faixa nos guias e na home + página /black-friday/ com o que conferir antes de
// comprar, por tipo. Nenhum preço, desconto ou "melhor"; a única data afirmada é a da Black Friday (sexta, 27/11/2026). O
// período da campanha da Amazon não é afirmado (as fontes divergem). A faixa sai no primeiro build depois de 30/11; a página
// fica como guia de compra.
import { amazonSearchUrl, type PageSpec } from '@bem-apoiado/core';
import { loadTopics } from '@bem-apoiado/engine';
import { KIND_LABEL, publicPages } from './content';

export const BF_DIA = '27/11';
const INICIO = Date.parse('2026-11-23T00:00:00-03:00');
const FIM = Date.parse('2026-12-01T00:00:00-03:00');
export const faixaAtiva = (agora = Date.now()) => agora >= INICIO && agora < FIM;

// O que conferir no anúncio: só pontos que os guias do site explicam.
export const GRUPOS: { id: string; rotulo: string; tipos: string[]; busca: string; conferir: string[] }[] = [
  { id: 'colchao', rotulo: 'Colchão', tipos: ['espuma', 'molas_ensacadas', 'molas_interligadas', 'misto'], busca: 'colchão', conferir: ['A densidade (D28, D33, D45) e para qual faixa de peso o fabricante indica.', 'A medida exata (solteiro, casal, queen, king) e a altura.', 'Se é de espuma, molas ensacadas, molas interligadas ou misto.'] },
  { id: 'travesseiro', rotulo: 'Travesseiro', tipos: ['travesseiro'], busca: 'travesseiro', conferir: ['A altura, conforme a posição em que você dorme.', 'O enchimento (espuma, fibra, pena) e se pode lavar.'] },
  { id: 'cama', rotulo: 'Base e acessórios do colchão', tipos: ['base_box', 'protetor', 'pillow_top'], busca: 'base cama box', conferir: ['A medida da base igual à do colchão e se tem baú.', 'No protetor e no pillow top, a altura do colchão que eles cobrem.'] },
  { id: 'roupa-de-cama', rotulo: 'Lençol, edredom e cobertor', tipos: ['jogo_de_cama', 'edredom', 'cobertor'], busca: 'jogo de cama', conferir: ['A medida para a sua cama (o lençol com elástico tem de cobrir a altura do colchão).', 'A composição na etiqueta (algodão, poliéster, percal, malha) e a gramatura do edredom.'] },
  { id: 'banho', rotulo: 'Toalha e roupão', tipos: ['toalha', 'roupao'], busca: 'toalha de banho', conferir: ['A gramatura e a composição (algodão, microfibra).', 'O tamanho: rosto, banho ou banhão.'] },
  { id: 'cadeira', rotulo: 'Cadeira de escritório', tipos: ['cadeira', 'mesa', 'suporte_notebook'], busca: 'cadeira de escritório', conferir: ['A altura mínima e máxima do assento e a capacidade de peso declarada.', 'O mecanismo de reclinação e os ajustes de braço e apoio lombar.'] },
];

export interface GrupoBF { id: string; rotulo: string; conferir: string[]; guias: { slug: string; title: string }[]; ofertas: string }
export function gruposBF(): GrupoBF[] {
  const topics = new Map(loadTopics().map((t) => [t.slug, t.product_kinds]));
  const pags = publicPages().filter((p) => p.status !== 'draft');
  return GRUPOS.map((g) => ({
    id: g.id, rotulo: g.rotulo, conferir: g.conferir,
    guias: pags.filter((p) => (topics.get(p.slug) ?? []).some((k) => g.tipos.includes(k))).slice(0, 5).map((p) => ({ slug: p.slug, title: p.title })),
    ofertas: amazonSearchUrl(g.busca),
  }));
}

export function faixaDaPagina(page?: PageSpec): { rotulo: string; url: string } {
  const kinds = page ? loadTopics().find((t) => t.slug === page.slug)?.product_kinds ?? [] : [];
  const g = GRUPOS.find((x) => kinds.some((k) => x.tipos.includes(k)));
  const tipo = kinds.find((k) => k !== 'outro' && KIND_LABEL[k]);
  if (g && tipo) return { rotulo: KIND_LABEL[tipo]!.toLowerCase(), url: amazonSearchUrl(KIND_LABEL[tipo]!) };
  return { rotulo: 'cama, mesa e banho', url: amazonSearchUrl('cama mesa e banho') };
}
