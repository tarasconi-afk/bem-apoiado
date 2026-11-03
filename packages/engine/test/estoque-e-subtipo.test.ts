import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 03/11: Teka Madri, cobertor de lã Zanzio e Karsten Flora entraram sem estoque (a trava só existia na renovação
// semanal), e um cobertor ponderado entrou como exemplo de "cobertor mais quente". Textos abaixo são os padrões
// reais dos anúncios guardados.
const root = mkdtempSync(join(tmpdir(), 'bem-estoque-'));
process.env.BEM_ROOT = root;
process.env.BEM_STATE_DIR = join(root, 'state');
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
mkdirSync(join(root, 'data/products-retired'), { recursive: true });
mkdirSync(join(root, 'data/products'), { recursive: true });
copyFileSync(join(import.meta.dirname, '../../../data/niche.json'), join(root, 'data/niche.json'));

const { semEstoque, avisoSemOferta } = await import('../src/listing-stock.ts');
const { kindExcluded, knownAsins } = await import('../src/stages/products.ts');
const { SEARCH_INDEX_NOTE } = await import('../src/snapshot.ts');

const COMPRA = '# Colchão Emma Original\nR$ 1.299,00\nPix R$ 1.199,00\nVeja também R$ 899,00\n';

describe('estoque do anúncio', () => {
  it('reconhece os avisos reais da Amazon', () => {
    expect(semEstoque(`## Considere estes itens disponíveis\n${COMPRA}`)).toMatch(/^sem estoque/);
    expect(semEstoque(`Não disponível. Não temos previsão de quando este produto estará disponível.\n${COMPRA}`)).toMatch(/^sem estoque/);
    expect(semEstoque(`Atualmente indisponível.\n${COMPRA}`)).toMatch(/^sem estoque/);
  });
  it('página lida direto sem preço = sem caixa de compra', () => {
    expect(semEstoque('### Desculpe, houve um problema.\n#### Imagem não disponível\n# Zanzio Cobertor de lã\n##### Pix')).toMatch(/não mostra preço/);
  });
  it('não confunde "Imagem não disponível" nem o resumo do índice de busca (que nunca tem preço)', () => {
    expect(semEstoque(`#### Imagem não disponível\n${COMPRA}`)).toBeNull();
    expect(semEstoque('Colchão Emma Original 25 cm - Amazon.com.br', { note: SEARCH_INDEX_NOTE })).toBeNull();
    expect(avisoSemOferta(`#### Imagem não disponível\n${COMPRA}`)).toBe(false);
  });
});

describe('subtipo de outro propósito', () => {
  it('cobertor ponderado não é exemplo de cobertor', () => {
    expect(kindExcluded('Sivio Cobertor pesado para dormir 2,3 kg', 'cobertor')).toBe('cobertor pesado');
    expect(kindExcluded('Cobertor Ponderado Infantil', 'cobertor')).toBe('ponderado');
    expect(kindExcluded('Döhler Cobertor Microfibra 350 g/m²', 'cobertor')).toBeNull();
    expect(kindExcluded('Travesseiro pesado', 'travesseiro')).toBeNull();
  });
});

describe('o que volta pela descoberta', () => {
  const ret = (asin: string, reason: string, daysAgo: number) =>
    writeFileSync(join(root, 'data/products-retired', `${asin}.json`), JSON.stringify({ asin, reason, retired_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }));
  it('sem estoque volta depois de 7 dias; recusa do editor nunca', () => {
    ret('B0000000A1', 'sem estoque: o anúncio avisa que não há oferta disponível', 8);
    ret('B0000000A2', 'sem estoque: a página do anúncio não mostra preço (sem caixa de compra)', 3);
    ret('B0000000A3', 'recusado pelo editor no painel', 30);
    const k = knownAsins();
    expect(k.has('B0000000A1')).toBe(false);
    expect(k.has('B0000000A2')).toBe(true);
    expect(k.has('B0000000A3')).toBe(true);
  });
});
