import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../src/stages/manual-edit.ts';

const d = {
  title: 'Título de teste longo o bastante', description: 'Descrição de teste com tamanho suficiente para o schema da página.',
  verdict: { text: 'Resposta curta original.', basis: 'reasoning', claim_ids: ['clm_a'] },
  sections: [{ id: 's1', heading: 'Seção', blocks: [
    { kind: 'paragraph', text: 'Texto original.', basis: 'evidence', claim_ids: ['clm_b'] },
    { kind: 'table', columns: ['a', 'b'], rows: [{ cells: [{ text: 'x', claim_ids: [] }, { text: 'y', claim_ids: [] }] }], caption: 'c' },
  ] }],
} as never;

describe('edição manual', () => {
  it('muda só texto de bloco não-tabela; fontes ficam; espaços normalizados; igual não conta', () => {
    const r = applyTextEdits(d, { verdict: '  Resposta   nova. ', 's1#0': 'Texto original.', 's1#1': 'tentativa na tabela', 's9#0': 'não existe' });
    expect(r.changed).toEqual(['verdict']);
    expect(r.draft.verdict).toEqual({ text: 'Resposta nova.', basis: 'reasoning', claim_ids: ['clm_a'] });
    expect((r.draft as any).sections[0].blocks[1].rows[0].cells[0].text).toBe('x');
    expect((d as any).verdict.text).toBe('Resposta curta original.');
  });
});
