import { describe, expect, it } from 'vitest';

describe('juiz por maioria', () => {
  it('cada pergunta pela maioria; enchimento só o apontado por 2 de 3; empate de resposta vira partial', async () => {
    const { majority } = await import('../src/stages/review.ts');
    const v = (a: 'yes' | 'partial' | 'no', quick: boolean, filler: string[]) => ({ answers_primary_query: a, concrete_guidance: true, reader_fit: true, quick_answer: quick, purchase_path: true, reader_problems: [], filler_refs: filler, decision_criteria: ['x', 'y'], missing: [], publishable: quick, summary: `${a}${quick}` });
    const m = majority([v('yes', true, ['a#0']), v('yes', false, ['a#0', 'b#1']), v('partial', true, [])]);
    expect(m.answers_primary_query).toBe('yes');
    expect(m.quick_answer).toBe(true);
    expect(m.filler_refs).toEqual(['a#0']);
    expect(majority([v('yes', true, []), v('partial', true, []), v('no', true, [])]).answers_primary_query).toBe('partial');
  });
});
