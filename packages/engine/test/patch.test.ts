import { describe, expect, it } from 'vitest';
import { applyPatches, refFromWhere } from '../src/stages/patch.ts';
import type { Draft } from '../src/stages/draft-schema.ts';

const base: Draft = {
  title: 'Título de teste suficiente',
  description: 'Descrição de teste com tamanho suficiente para passar no schema de rascunho.',
  verdict: { text: 'Veredito original de teste.', basis: 'reasoning', claim_ids: ['clm_a'] },
  sections: [
    {
      id: 'tipos',
      heading: 'Tipos',
      blocks: [
        { kind: 'paragraph', text: 'Bloco A aprovado.', basis: 'evidence', claim_ids: ['clm_a'] },
        { kind: 'paragraph', text: 'Bloco B com problema.', basis: 'evidence', claim_ids: ['clm_b'] },
        {
          kind: 'table',
          caption: 'Tabela',
          columns: ['Tipo', 'Valor'],
          rows: [
            { cells: [{ text: 'X', claim_ids: [] }, { text: '1', claim_ids: ['clm_a'] }] },
            { cells: [{ text: 'Y', claim_ids: [] }, { text: '2', claim_ids: ['clm_b'] }] },
          ],
        },
      ],
    },
    { id: 'so-um', heading: 'Só um bloco', blocks: [{ kind: 'paragraph', text: 'Único.', basis: 'evidence', claim_ids: ['clm_a'] }] },
  ],
};

describe('applyPatches', () => {
  it('troca só o bloco apontado e mantém os aprovados intactos', () => {
    const d = applyPatches(base, [{ ref: 'tipos#1', action: 'replace', text: 'Bloco B estreitado.', basis: 'evidence', claim_ids: ['clm_b'] }]);
    expect(d.sections[0]!.blocks[0]).toEqual(base.sections[0]!.blocks[0]);
    expect(d.sections[0]!.blocks[1]).toMatchObject({ text: 'Bloco B estreitado.' });
    expect(base.sections[0]!.blocks[1]).toMatchObject({ text: 'Bloco B com problema.' }); // original não muda
  });

  it('remove linha de tabela e bloco sem bagunçar os índices', () => {
    const d = applyPatches(base, [
      { ref: 'tipos#2.r1', action: 'remove' },
      { ref: 'tipos#1', action: 'remove' },
    ]);
    const blocks = d.sections[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.kind === 'table' && blocks[1]!.rows).toHaveLength(1);
  });

  it('seção que fica vazia some', () => {
    const d = applyPatches(base, [{ ref: 'so-um#0', action: 'remove' }]);
    expect(d.sections.map((s) => s.id)).toEqual(['tipos']);
  });
});

describe('refFromWhere', () => {
  it('traduz o where do gate para a ref de bloco', () => {
    expect(refFromWhere('section:tipos#2.r1c1')).toBe('tipos#2.r1');
    expect(refFromWhere('section:tipos#0')).toBe('tipos#0');
    expect(refFromWhere('verdict')).toBe('verdict');
    expect(refFromWhere('status')).toBeNull();
  });
});

import { makePatchSchema as mps } from '../src/stages/patch.ts';
describe('remendo de linha de tabela', () => {
  it('recusa número de células diferente do número de colunas', () => {
    const schema = mps(['s#0.r1'], ['clm_a'], new Map([['s#0.r1', ['Tipo', 'Altura', 'Material', 'Indicação']]]));
    const cell = { text: 'x', claim_ids: [] as string[] };
    expect(schema.safeParse({ patches: [{ ref: 's#0.r1', action: 'replace', cells: [cell, cell, cell] }] }).success).toBe(false);
    expect(schema.safeParse({ patches: [{ ref: 's#0.r1', action: 'replace', cells: [cell, cell, cell, cell] }] }).success).toBe(true);
    expect(schema.safeParse({ patches: [{ ref: 's#0.r1', action: 'remove' }] }).success).toBe(true);
  });
});
