import { describe, expect, it } from 'vitest';
import { possibleGaps } from '../src/stages/readiness.ts';

describe('lacunas impossíveis (27/10)', () => {
  it('tira só a falta que é inteira sobre dinheiro', () => {
    const impossiveis = [
      'Preços de protetores e de limpeza, reparo ou substituição de colchão para calcular quando o protetor compensa.',
      'Comparação de preço entre a cadeira com apoio incluído e o acessório vendido separadamente.',
      'Custo total do protetor e evidência do benefício econômico, como custo evitado de limpeza.',
      'Dado de fonte primária que mostre se o resultado justifica o investimento.',
    ];
    expect(possibleGaps(impossiveis)).toEqual([]);
  });

  it('mantém a falta pesquisável que só cita dinheiro de passagem (casos reais de 27/10)', () => {
    const reais = [
      'Uma resposta direta sobre quando a base baú vale a pena e quais são as principais desvantagens em relação a uma base comum, como preço, peso e acesso ao compartimento.',
      'Comparação de faixas de regulagem, capacidades, dimensões e preços ou posicionamento entre mais de um fabricante e mais de um modelo.',
      'Informação de fonte primária que explique qual problema o protetor resolve e em quais situações o fabricante recomenda usá-lo, para comparar comprar com não comprar.',
      'Tabela do fabricante relacionando peso e densidade.',
      'Medidas do solteirão confirmadas por um segundo fabricante.',
    ];
    expect(possibleGaps(reais)).toEqual(reais);
  });
});
