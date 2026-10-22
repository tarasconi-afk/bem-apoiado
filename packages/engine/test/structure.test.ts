import { describe, expect, it } from 'vitest';
import { applyMoves, decisionLast, dropClaimless } from '../src/stages/structure.ts';

const txt = (text: string, claim_ids = ['c']) => ({ kind: 'text', text, basis: 'evidence', claim_ids }) as never;
const tab = (caption: string) => ({ kind: 'table', caption, columns: ['a', 'b'], rows: [] }) as never;
const page = () => ({
  title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
  sections: [
    { id: 'como-decidir', heading: 'Como decidir: escolha pela faixa de peso', blocks: [tab('Densidade por peso'), txt('A')] },
    { id: 'o-que-e', heading: 'O que é densidade', blocks: [txt('B')] },
    { id: 'etiqueta', heading: 'O que conferir na etiqueta antes de comprar', blocks: [txt('C'), txt('D')] },
  ],
}) as never;

describe('estrutura sem IA', () => {
  it('"Como decidir" vai para o fim (o site mostra a última seção no topo)', () => {
    expect(decisionLast(page()).sections.map((s) => s.id)).toEqual(['o-que-e', 'etiqueta', 'como-decidir']);
  });
  it('move a tabela para depois do 1º bloco da seção de destino, sem mexer no conteúdo', () => {
    const r = applyMoves(page(), [{ ref: 'como-decidir#0', to: 'etiqueta', position: 'after_first' }]);
    const et = r.draft.sections.find((s) => s.id === 'etiqueta')!;
    expect(et.blocks.map((b) => (b.kind === 'table' ? `T:${b.caption}` : b.text))).toEqual(['C', 'T:Densidade por peso', 'D']);
    expect(r.done).toEqual(['como-decidir#0 → etiqueta']);
  });
  it('ignora movimento para a própria seção ou ref inexistente', () => {
    expect(applyMoves(page(), [{ ref: 'etiqueta#0', to: 'etiqueta', position: 'end' }, { ref: 'x#9', to: 'etiqueta', position: 'end' }]).done).toEqual([]);
  });
  it('descarta só bloco tocado e sem fonte', () => {
    const d = page() as { sections: { blocks: unknown[] }[] };
    d.sections[2]!.blocks.push(txt('sem fonte', []));
    const r = dropClaimless(d as never, new Set(['etiqueta#2']));
    expect(r.dropped).toEqual(['etiqueta#2']);
    expect(r.draft.sections[2]!.blocks).toHaveLength(2);
  });
});

describe('tabela leva o parágrafo que a apresenta', () => {
  it('parágrafo curto logo antes da tabela vai junto, na mesma ordem', () => {
    const d = {
      title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
      sections: [
        { id: 'medidas', heading: 'Medidas', blocks: [txt('Confira a ficha técnica do modelo.'), tab('Medidas por tamanho')] },
        { id: 'outra', heading: 'Outra', blocks: [txt('B')] },
        { id: 'mais', heading: 'Mais', blocks: [txt('E')] },
        { id: 'decidir', heading: 'O que conferir antes de comprar', blocks: [txt('C')] },
      ],
    } as never;
    const r = applyMoves(d, [{ ref: 'medidas#1', to: 'decidir', position: 'end' }]);
    const dec = r.draft.sections.find((s) => s.id === 'decidir')!;
    expect(dec.blocks.map((b) => (b.kind === 'table' ? 'T' : b.text))).toEqual(['C', 'Confira a ficha técnica do modelo.', 'T']);
    expect(r.draft.sections.map((s) => s.id)).toEqual(['outra', 'mais', 'decidir']);
  });
});

describe('parágrafo de abertura leva a tabela', () => {
  it('apontar o parágrafo curto antes da tabela move os dois', () => {
    const d = {
      title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
      sections: [
        { id: 'medidas', heading: 'Medidas', blocks: [txt('Confira a ficha técnica do modelo.'), tab('Medidas')] },
        { id: 'a', heading: 'A', blocks: [txt('B')] }, { id: 'b', heading: 'B', blocks: [txt('E')] },
        { id: 'decidir', heading: 'Decidir', blocks: [txt('C')] },
      ],
    } as never;
    const dec = applyMoves(d, [{ ref: 'medidas#0', to: 'decidir', position: 'end' }]).draft.sections.at(-1)!;
    expect(dec.blocks.map((b) => (b.kind === 'table' ? 'T' : b.text))).toEqual(['C', 'Confira a ficha técnica do modelo.', 'T']);
  });
});
