import { describe, expect, it } from 'vitest';
import { cutAtWord } from '../src/board.ts';

// 28/10, o editor lendo o cartão do ciclo: "...conforme frio, volume, uso ou prefe". O corte por número de
// letras partia a palavra no meio e a frase da lacuna ficava sem sentido justamente onde ela explica o motivo
// de a página não ter saído.
describe('texto do cartão não quebra no meio da palavra', () => {
  const corte = (t: string, max: number) => {
    const c = cutAtWord(t, max);
    return c.length < t.length ? `${c}…` : c;
  };
  const LACUNA = 'Uma fonte primária voltada ao comprador que compare edredom e cobertor e indique quando escolher cada um conforme frio, volume, uso ou preferência de peso';

  it('o caso real: termina em palavra inteira, com reticências', () => {
    const t = corte(LACUNA, 140);
    expect(t).toMatch(/…$/);
    expect(t).not.toMatch(/prefe…$/); // o que o editor leu no cartão
    // A última palavra do corte tem de existir inteira no original: nada de "prefe" ou "preferênc".
    const ultima = t.replace('…', '').split(' ').at(-1)!;
    expect(LACUNA.split(/[\s,]+/)).toContain(ultima);
  });

  it('texto que cabe não ganha reticências nem perde nada', () => {
    expect(corte('falta uma fonte do fabricante', 140)).toBe('falta uma fonte do fabricante');
  });

  it('não deixa vírgula ou espaço pendurado antes das reticências', () => {
    expect(corte('a, b, c, d, e, f', 8)).toBe('a, b…');
  });
});
