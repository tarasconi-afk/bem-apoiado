import { describe, expect, it } from 'vitest';
import { keepFixingCoherence } from '../src/stages/page.ts';

// 28/10: "travesseiro NASA" tinha 2 achados de coerência. A única rodada de conserto resolveu 1 e a página virou
// rascunho pelo outro — um título de seção —, com o juiz dando 4 de 4. A rodada extra existe para esse caso, e só
// para ele: enquanto o número de achados cair, vale pagar outra.

describe('quando vale pagar outra rodada de conserto da coerência', () => {
  it('página limpa não ganha rodada nenhuma', () => {
    expect(keepFixingCoherence(1, 2, 0)).toBe(false);
  });

  it('caiu de 2 para 1: ganha a rodada extra (o caso do NASA)', () => {
    expect(keepFixingCoherence(1, 2, 1)).toBe(true);
  });

  it('não caiu: para onde parava antes', () => {
    expect(keepFixingCoherence(1, 2, 2)).toBe(false);
  });

  it('piorou: para também', () => {
    expect(keepFixingCoherence(1, 1, 3)).toBe(false);
  });

  it('cair sempre não roda para sempre: há um teto de rodadas', () => {
    expect(keepFixingCoherence(2, 3, 2)).toBe(true);
    expect(keepFixingCoherence(3, 2, 1)).toBe(false);
  });
});
