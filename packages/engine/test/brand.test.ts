import { describe, expect, it } from 'vitest';
import { brandProblem } from '../src/stages/products.ts';

describe('marca do produto', () => {
  it('recusa vazia, genérica, artigo e especificação no lugar da marca', () => {
    expect(brandProblem('Ortobom', 'Colchão de espuma')).toBeNull();
    expect(brandProblem('Herval', 'Colchão de molas ensacadas')).toBeNull();
    expect(brandProblem('', 'Colchão de espuma')).toMatch(/genérica/);
    expect(brandProblem('Espuma', 'Colchão de espuma')).toMatch(/genérica/);
    expect(brandProblem('D33', 'Colchão de espuma')).toMatch(/implausível/);
    expect(brandProblem('O armazenamento do colchão', 'Colchão de espuma')).toMatch(/implausível/);
  });
});
