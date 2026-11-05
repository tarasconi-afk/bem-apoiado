import { describe, expect, it } from 'vitest';
import { sameIntent } from '../src/stages/ideas.ts';

// Casos reais da fila de 05/11: a triagem pelo modelo deixou passar estas repetições.
describe('mesma intenção de busca', () => {
  it.each([
    ['quando trocar colchão', 'quando trocar o colchão'],
    ['colchão de molas ensacadas ou espuma', 'colchão de molas ou espuma'],
    ['base de cama box casal: qual escolher', 'base para cama box: o que conferir'],
    ['qual densidade de colchão escolher', 'guia de densidades de colchão'],
    ['travesseiro de látex ou viscoelástico qual escolher', 'travesseiro de látex ou viscoelástico'],
    ['protetor de colchão: qual escolher', 'protetor de colchão vale a pena'],
  ])('"%s" repete "%s"', (a, b) => expect(sameIntent(a, b)).toBe(true));

  it.each([
    ['como escolher lençol', 'lençol de percal ou algodão: diferença'],
    ['travesseiro para quem dorme de lado', 'colchão para quem dorme de lado'],
    ['edredom ou cobertor: diferença', 'edredom ou duvet: diferença'],
    ['tamanho de edredom: como escolher', 'enchimento de edredom: pluma, pena ou fibra'],
    ['colchão de espuma ou de látex', 'colchão de látex vale a pena'],
  ])('"%s" é outra pauta que "%s"', (a, b) => expect(sameIntent(a, b)).toBe(false));
});
