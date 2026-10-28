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
    expect(l!.text).toMatch(/espaço/i);
  });

  // O prompt carrega todas as lições; uma lição longa demais empurra as outras e some em silêncio.
  it('nenhuma lição passa de 240 caracteres', () => {
    for (const l of lessons) expect(l.text.length, l.text.slice(0, 60)).toBeLessThanOrEqual(240);
  });

  // 27/10: o teto cortou 4 lições em silêncio quando duas novas entraram. O teto é 20 e hoje são 19.
  it('a lista cabe no teto, com folga para o editor ainda ensinar', () => {
    expect(lessons.length).toBeLessThanOrEqual(20);
    expect(dedupeLessons(lessons).length).toBe(lessons.length); // nenhuma repetida
  });
});
