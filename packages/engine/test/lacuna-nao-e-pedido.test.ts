import { describe, expect, it } from 'vitest';
import { aboutRequest } from '../src/stages/requests.ts';

// 05/11: textos reais de data/source-gaps.json.
describe('explicação sobre o pedido não vira lacuna de fonte', () => {
  it('recusa o que fala do pedido ou de um bloco', () => {
    expect(aboutRequest('O pedido não especifica quais produtos ou exemplos devem ser removidos dos blocos. Os blocos mencionam fabricantes')).toBe(true);
    expect(aboutRequest('O bloco cuidados-conservacao#0 cita o lençol Atlântis de 180 fios da Döhler, que está fora da comparação. Pode-se remover o bloco inteiro')).toBe(true);
  });

  it('mantém o que é falta de informação de verdade', () => {
    for (const t of [
      "Aprofundar a seção 'Cuidados de conservação' com exigências do Inmetro e diferenças entre lavar/secar edredom e cobertor requer pesquisa em regulamentações e fichas de fabricantes não disponíveis no conteúdo fornecido.",
      'Regra do fabricante para escolher a densidade de um único colchão quando os dois ocupantes têm pesos diferentes.',
      'Uma tabela de fabricante relacionando peso corporal à densidade ou espessura específica do pillow top.',
      'Pesquisar declarações de fabricantes sobre travesseiros de fibra quanto a posição de dormir e ajuste de altura.',
    ]) expect(aboutRequest(t)).toBe(false);
  });
});
