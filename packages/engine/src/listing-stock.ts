import type { Source } from '@bem-apoiado/core';
import { SEARCH_INDEX_NOTE } from './snapshot.ts';

// Estoque do anúncio: vale na ENTRADA do produto e na renovação semanal.
//
// 03/11: o editor recusou Teka Madri e o cobertor de lã Zanzio porque estavam sem estoque na Amazon, e o
// Karsten Flora (aceito no mesmo dia) também estava. A trava existia só na renovação, sete dias depois, e com
// uma lista que não reconhecia nenhum dos três: a Teka dizia "Considere estes itens disponíveis" (o bloco que
// a Amazon põe no lugar da compra), o Karsten "Não disponível. Não temos previsão…" numa linha só, e a Zanzio
// não tinha preço nenhum. Medido nos 15 anúncios lidos direto: os 12 com compra têm de 45 a 216 preços; os 4
// sem compra (Teka, Zanzio, Karsten Flora, Probel Guarda-Costas) têm de 0 a 2 e nenhum botão de compra.
const SEM_OFERTA = [
  /nenhuma oferta em destaque dispon[ií]vel/i,
  /atualmente indispon[ií]vel/i,
  /n[ãa]o temos previs[ãa]o de quando este produto/i,
  /considere estes itens dispon[ií]veis/i,
  // Linha que começa com o aviso ("Imagem não disponível" começa com outra palavra e não conta).
  /^\W*n[ãa]o dispon[ií]vel\.?(\s|$)/im,
];
const PRECO = /R\$\s?\d/g;
// Anúncio com compra traz o preço do próprio produto e os dos carrosséis; abaixo disto não há caixa de compra.
const MIN_PRECOS = 3;

export const ESTOQUE_PREFIX = 'sem estoque';

export const avisoSemOferta = (text: string) => SEM_OFERTA.some((re) => re.test(text));

// Devolve o motivo quando o anúncio não tem compra possível, ou null. O resumo do índice de busca (página
// bloqueada) não traz preço nem caixa de compra: ali só o aviso explícito conta.
export function semEstoque(text: string, source?: Pick<Source, 'note'>): string | null {
  if (avisoSemOferta(text)) return `${ESTOQUE_PREFIX}: o anúncio avisa que não há oferta disponível`;
  if (source?.note === SEARCH_INDEX_NOTE) return null;
  const precos = text.match(PRECO)?.length ?? 0;
  if (precos < MIN_PRECOS) return `${ESTOQUE_PREFIX}: a página do anúncio não mostra preço (sem caixa de compra)`;
  return null;
}
