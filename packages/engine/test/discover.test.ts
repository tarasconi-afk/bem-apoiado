import { describe, expect, it } from 'vitest';
import { classify } from '../src/stages/discover.ts';

const reg = {
  allow: [
    { host: 'gov.br', path: '/inmetro', publisher: 'Inmetro', source_class: 'regulator' as const },
    { host: 'probel.com.br', publisher: 'Probel', source_class: 'manufacturer' as const },
  ],
  block: ['youtube.com', 'buscape.com.br'],
};

describe('classify', () => {
  it('aceita só domínio e caminho cadastrados', () => {
    expect(classify('https://www.gov.br/inmetro/pt-br/x', reg)).toEqual({ publisher: 'Inmetro', source_class: 'regulator' });
    expect(classify('https://blog.probel.com.br/post', reg)).toMatchObject({ publisher: 'Probel' });
  });
  it('gov.br de outro órgão não entra sozinho', () => {
    expect(classify('https://www.gov.br/receitafederal/x', reg)).toBe('unknown');
  });
  it('bloqueia vídeo e comparador, inclusive subdomínio', () => {
    expect(classify('https://m.youtube.com/watch?v=1', reg)).toBe('blocked');
    expect(classify('https://www.buscape.com.br/x', reg)).toBe('blocked');
  });
  it('não confunde domínio parecido', () => {
    expect(classify('https://probel.com.br.golpe.net/x', reg)).toBe('unknown');
  });
});
