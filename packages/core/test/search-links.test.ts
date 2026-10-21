import { describe, expect, it } from 'vitest';
import { amazonSearchUrl, searchLinkProblem } from '../src/index.ts';

describe('buscas na Amazon', () => {
  it('link de busca leva a nossa tag', () => {
    expect(amazonSearchUrl('cadeira escritório regulagem altura')).toBe('https://www.amazon.com.br/s?k=cadeira+escrit%C3%B3rio+regulagem+altura&tag=bemapoiado-20');
  });
  it('recusa promoção, ranking e termo vetado', () => {
    expect(searchLinkProblem({ label: 'Cadeiras com regulagem de altura', query: 'cadeira regulagem altura' }, [])).toBeNull();
    expect(searchLinkProblem({ label: 'As melhores cadeiras', query: 'melhor cadeira escritório' }, [])).toMatch(/promoção/);
    expect(searchLinkProblem({ label: 'Colchão que cura dor nas costas', query: 'colchão dor nas costas' }, ['dor nas costas'])).toMatch(/vetado/);
    expect(searchLinkProblem({ label: 'Cadeiras', query: 'cadeira' }, [])).not.toBeNull();
  });
});
