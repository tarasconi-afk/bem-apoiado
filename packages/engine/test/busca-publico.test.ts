import { describe, expect, it } from 'vitest';
import { publicoQueAPaginaNaoTem } from '../src/stages/search-links.ts';

// 03/11, travesseiro de corpo: o gerador de buscas criou "Travesseiro de corpo para grávidas" numa página com zero
// menções a gravidez. A busca na Amazon é o último clique antes da compra, e nenhum portão olhava para ela.
describe('busca na Amazon não inventa público nem uso de saúde', () => {
  const pagina = 'travesseiro de corpo para quem dorme de lado: confira o comprimento e o enchimento';
  const busca = (label: string, query = label) => ({ label, query });

  it('público que a página não menciona sai', () => {
    expect(publicoQueAPaginaNaoTem(busca('Travesseiro de corpo para grávidas'), pagina)).toBe(true);
  });

  it('o mesmo público passa quando a página fala dele', () => {
    expect(publicoQueAPaginaNaoTem(busca('Travesseiro de corpo para grávidas'), pagina + ' indicado na gravidez segundo o fabricante')).toBe(false);
  });

  // "dor" está dentro de "dorme": comparar pelo começo da palavra deixaria passar.
  it('"dor" não é confundido com "dorme"', () => {
    expect(publicoQueAPaginaNaoTem(busca('Travesseiro para dor nas costas'), pagina)).toBe(true);
  });

  it('busca sem público nem saúde passa', () => {
    expect(publicoQueAPaginaNaoTem(busca('Travesseiro de corpo para dormir de lado'), pagina)).toBe(false);
  });
});
