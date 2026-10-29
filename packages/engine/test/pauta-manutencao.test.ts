import { describe, expect, it } from 'vitest';
import { dedupeLessons, loadEditorLessons } from '../src/editor-lessons.ts';

// 28/10, o editor sobre o rascunho de edredom ou cobertor: "sinto falta de diferenças na limpeza, espaço para
// guardar". O redator não omitiu nada — nenhuma das 7 perguntas da pauta tratava disso, e a página só responde o
// que a pauta perguntou. A lição abaixo e a regra do planejador existem para esse caso.
describe('manutenção e espaço entram como critério de decisão', () => {
  const lessons = loadEditorLessons().lessons;

  it('a lição está na lista que vai para o redator', () => {
    const l = lessons.find((x) => /conserva/i.test(x.text));
    expect(l, 'nenhuma lição sobre conservação').toBeDefined();
    expect(l!.text).toMatch(/lavar/i);
    expect(l!.text).toMatch(/medidas/i);
  });

  // 29/10: a primeira versão mandava "oriente quem tem pouco espaço". O redator obedeceu, e o juiz de coerência
  // recusou o bloco ("os trechos não relacionam essas medidas à facilidade de armazenar"), com a correção
  // automática voltando OVERSTATED. A lição pede o dado declarado; a conclusão sobre o armário é do leitor.
  it('a lição pede o dado declarado, não a conclusão sobre o espaço do leitor', () => {
    const l = lessons.find((x) => /conserva/i.test(x.text))!;
    expect(l.text).toMatch(/não conclua/i);
    expect(l.text).not.toMatch(/oriente quem/i);
  });

  // O prompt carrega todas as lições, então regra que vira parágrafo encarece toda página e dilui as outras.
  // O teto de 240 em learnFromEditor vale para a lição APRENDIDA do pedido; as inseridas à mão numa auditoria
  // não passam por ele (há uma de 256). O limite útil aqui é o que separa regra de redação: 300.
  it('lição é regra curta, não parágrafo', () => {
    for (const l of lessons) expect(l.text.length, l.text.slice(0, 60)).toBeLessThanOrEqual(300);
    expect(lessons.reduce((t, l) => t + l.text.length, 0)).toBeLessThan(4000); // o que entra em todo prompt
  });

  // 27/10: o teto cortou 4 lições em silêncio quando duas novas entraram. O teto é 20 e hoje são 19.
  it('a lista cabe no teto, com folga para o editor ainda ensinar', () => {
    expect(lessons.length).toBeLessThanOrEqual(20);
    expect(dedupeLessons(lessons).length).toBe(lessons.length); // nenhuma repetida
  });
});
