import { describe, expect, it } from 'vitest';
import { placeLinks, validAnchor } from '../src/links.ts';

const para = (text: string) => ({ kind: 'paragraph' as const, text, basis: 'claim' as const, claim_ids: [] });
const page = {
  slug: 'como-escolher-colchao',
  sections: [
    { id: 'a', heading: 'Tipos', blocks: [para('Há colchões de Molas Ensacadas e de espuma; molas ensacadas de novo.'), para('A densidade da espuma importa, e molas ensacadas também.')] },
    { id: 'b', heading: 'Tabela', blocks: [{ kind: 'table' as const, caption: 'x', columns: ['a', 'b'], rows: [{ cells: [{ text: 'densidade', claim_ids: [] }, { text: 'x', claim_ids: [] }] }] }] },
    { id: 'c', heading: 'Fim', blocks: [para('Falamos de densidade aqui.'), para('Sem âncora: densidades.')] },
  ],
};

describe('links internos', () => {
  it('liga a primeira ocorrência, 1 vez por destino, 1 por bloco, pula tabela e a própria página', () => {
    const m = placeLinks(page as never, [
      { slug: 'colchao-de-molas-ou-espuma', anchors: ['molas ensacadas'] },
      { slug: 'colchao-d28-ou-d33', anchors: ['densidade', 'densidade da espuma'] },
      { slug: 'como-escolher-colchao', anchors: ['colchões'] },
    ]);
    expect([...m.keys()]).toEqual(['a#0', 'a#1']);
    expect(m.get('a#0')).toMatchObject({ slug: 'colchao-de-molas-ou-espuma', start: 15 });
    // a mais longa ganha no mesmo lugar
    expect(page.sections[0]!.blocks[1]!.kind === 'paragraph' && page.sections[0]!.blocks[1]!.text.slice(m.get('a#1')!.start, m.get('a#1')!.end)).toBe('densidade da espuma');
  });

  it('não liga dentro de palavra maior e respeita o teto', () => {
    const m = placeLinks({ slug: 'x', sections: [{ id: 'c', heading: 'h', blocks: [para('Sem âncora: densidades.')] }] } as never, [{ slug: 'y', anchors: ['densidade'] }]);
    expect(m.size).toBe(0);
    const many = { slug: 'x', sections: [{ id: 's', heading: 'h', blocks: ['um', 'dois', 'tres', 'quatro', 'cinco'].map((w) => para(`palavra ${w} aqui`)) }] };
    expect(placeLinks(many as never, ['um', 'dois', 'tres', 'quatro', 'cinco'].map((w) => ({ slug: w, anchors: [w] }))).size).toBe(4);
  });

  it('âncora válida: curta, sem pontuação, não só o nome do produto', () => {
    expect(validAnchor('molas ensacadas', ['colchão'])).toBe(true);
    expect(validAnchor('Colchão', ['colchão'])).toBe(false);
    expect(validAnchor('um texto longo demais para ser âncora', [])).toBe(false);
    expect(validAnchor('densidade, firmeza', [])).toBe(false);
  });
});
