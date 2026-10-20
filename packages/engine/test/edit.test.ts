import { describe, expect, it } from 'vitest';
import { applyEdits } from '../src/stages/edit.ts';
import type { Draft } from '../src/stages/draft-schema.ts';

const base: Draft = {
  title: 'Título de teste suficiente',
  description: 'Descrição de teste com tamanho suficiente para passar no schema de rascunho.',
  verdict: { text: 'Veredito.', basis: 'reasoning', claim_ids: ['clm_a'] },
  sections: [
    {
      id: 'tipos',
      heading: 'Tipos',
      blocks: [
        { kind: 'paragraph', text: 'A diz isso.', basis: 'evidence', claim_ids: ['clm_a'] },
        { kind: 'paragraph', text: 'B repete A.', basis: 'evidence', claim_ids: ['clm_b'] },
        { kind: 'paragraph', text: 'C é outra coisa.', basis: 'evidence', claim_ids: ['clm_c'] },
      ],
    },
  ],
};

describe('applyEdits', () => {
  it('junta B em A citando só evidências que já estavam neles', () => {
    const r = applyEdits(base, [{ ref: 'tipos#0', action: 'rewrite', text: 'A e B juntos.', claim_ids: ['clm_a', 'clm_b'], absorbs: ['tipos#1'], reason: 'repetição' }]);
    expect(r.refused).toEqual([]);
    expect(r.draft.sections[0]!.blocks.map((b) => (b.kind === 'table' ? '' : b.text))).toEqual(['A e B juntos.', 'C é outra coisa.']);
  });

  it('recusa reescrita que traz evidência de outro bloco', () => {
    const r = applyEdits(base, [{ ref: 'tipos#0', action: 'rewrite', text: 'A com fato de C.', claim_ids: ['clm_a', 'clm_c'], reason: 'x' }]);
    expect(r.refused[0]).toContain('evidência que o bloco não tinha');
    expect(r.draft).toEqual(base);
  });

  it('não remove o veredito nem esvazia seção', () => {
    const one: Draft = { ...base, sections: [{ ...base.sections[0]!, blocks: [base.sections[0]!.blocks[0]!] }] };
    const r = applyEdits(one, [
      { ref: 'verdict', action: 'remove', reason: 'x' },
      { ref: 'tipos#0', action: 'remove', reason: 'x' },
    ]);
    expect(r.refused).toHaveLength(2);
    expect(r.draft).toEqual(one);
  });
});
