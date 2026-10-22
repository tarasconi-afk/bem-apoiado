import { describe, expect, it } from 'vitest';
import { duplicateBlocks, withoutDuplicates } from '../src/stages/duplicates.ts';

const para = (text: string) => ({ kind: 'paragraph' as const, text, basis: 'claim' as const, claim_ids: [] });
const inmetro = 'A certificação do Inmetro avalia apenas a espuma flexível de poliuretano, revestimento e chapa dura dos colchões vendidos.';
const d = {
  title: 't', description: 'd', verdict: { text: 'v', basis: 'reasoning' as const, claim_ids: [] },
  sections: [
    { id: 'detalhe', heading: 'Detalhe', blocks: [para('Segundo a Probel, há colchões de espuma nas densidades D28, D33 e D45 para estilos de sono diferentes, com suporte equilibrado e adaptação ao corpo.'), para('Outro assunto bem diferente sobre garantias de fabricantes e prazos de troca das peças.')] },
    { id: 'inmetro', heading: 'Inmetro', blocks: [para(`O Inmetro avalia por certificação compulsória. ${inmetro}`), para(inmetro)] },
    { id: 'como-decidir', heading: 'Como decidir', blocks: [para('Segundo a Probel, há colchões de espuma nas densidades D28, D33 e D45 para estilos de sono diferentes, com suporte equilibrado e adaptação ao corpo. confira.')] },
  ],
};

describe('parágrafos repetidos', () => {
  it('acha a cópia; entre decisão e detalhe, sai a do detalhe; dentro da seção, sai a de depois', () => {
    const r = duplicateBlocks(d as never).map((x) => x.ref).sort();
    expect(r).toEqual(['detalhe#0', 'inmetro#1']);
    const w = withoutDuplicates(d as never);
    expect(w.draft.sections.find((s) => s.id === 'como-decidir')!.blocks).toHaveLength(1);
    expect(w.draft.sections.find((s) => s.id === 'inmetro')!.blocks).toHaveLength(1);
  });
});

describe('mesmo dado com outras palavras', () => {
  it('blocos com os mesmos 5+ números são repetição; números diferentes não', async () => {
    const { duplicateBlocks } = await import('../src/stages/duplicates.ts');
    const blk = (text: string) => ({ kind: 'text', text, basis: 'evidence', claim_ids: ['c'] });
    const d = (a: string, b: string) => ({ title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] }, sections: [
      { id: 'detalhe', heading: 'Detalhe', blocks: [blk(a)] }, { id: 'outra', heading: 'Outra', blocks: [blk('Texto qualquer sem números relevantes aqui para a seção.')] }, { id: 'como-decidir', heading: 'Como decidir', blocks: [blk(b)] }] });
    const a = 'Segundo a Castor, as densidades indicadas por faixa de peso são: até 50 kg, D23; de 51 a 60 kg, D26; de 61 a 70 kg, D28.';
    const b = 'Se você pesa até 50 kg, procure D23; de 51 a 60 kg, D26; de 61 a 70 kg, D28.';
    expect(duplicateBlocks(d(a, b) as never).map((x) => x.ref)).toEqual(['detalhe#0']);
    expect(duplicateBlocks(d(a, 'Se você pesa de 81 a 100 kg, procure D33 a D45; acima de 100 kg, D45 ou maior.') as never)).toEqual([]);
  });
});
