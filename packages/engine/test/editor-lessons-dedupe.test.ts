import { describe, expect, it } from 'vitest';
import { dedupeLessons } from '../src/editor-lessons.ts';

const l = (text: string) => ({ text });

describe('lista de lições (27/10)', () => {
  it('corta o texto repetido que o merge de dois ramos duplicou', () => {
    const a = l('A resposta curta começa pela resposta prática para quem vai comprar.');
    const b = l('Tabela de comparação tem uma linha por opção.');
    expect(dedupeLessons([a, b, l('a RESPOSTA curta começa pela resposta prática para quem vai comprar!')])).toEqual([a, b]);
  });

  it('respeita o teto mesmo quando o git junta duas listas', () => {
    const muitas = Array.from({ length: 40 }, (_, i) => l(`Regra distinta de número ${i} para o redator seguir.`));
    expect(dedupeLessons(muitas)).toHaveLength(20);
    expect(dedupeLessons(muitas, 5)).toHaveLength(5);
  });

  it('não apaga regra parecida: isso é decisão do editor no painel', () => {
    // Caso real de 27/10: dois ajustes em ramos diferentes geraram a mesma regra com outras palavras. Medir
    // semelhança por palavras apagava também uma regra legítima, então as duas ficam e o editor remove uma.
    const nova = l('Elimine parágrafos introdutórios que só anunciam o próximo assunto sem informar o comprador.');
    const antiga = l('Remova frases que apenas anunciam o próximo assunto sem informar nada que ajude o comprador a decidir.');
    expect(dedupeLessons([nova, antiga])).toHaveLength(2);
  });
});
