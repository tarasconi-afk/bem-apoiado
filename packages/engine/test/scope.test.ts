import { describe, expect, it } from 'vitest';
import { assignScopes, scopeByClass, scopeQuestion } from '../src/stages/scope.ts';
import type { Decider } from '../src/jev.ts';

const src = (id: string, source_class: string, title: string) => ({ id, publisher: 'Castor', source_class, title, final_url: `https://x.test/${id}` }) as never;
const clm = (id: string, source_id: string, statement: string) => ({ id, source_id, statement, quote: statement, claim_type: 'spec', captured_at: '2026-10-20T12:00:00.000Z', question_ids: [] }) as never;

describe('alcance das evidências antigas (27/10)', () => {
  it('classe da fonte decide sem modelo; fabricante vai ao decisor em lotes', async () => {
    const sources = new Map([
      ['src_norma', src('src_norma', 'standard_body', 'ABNT NBR 17034')],
      ['src_loja', src('src_loja', 'retailer_listing', 'Anúncio')],
      ['src_guia', src('src_guia', 'manufacturer', 'Medidas de colchão')],
      ['src_ficha', src('src_ficha', 'manufacturer', 'Colchão Sleep Max 96x203')],
    ]);
    const claims = [clm('clm_a', 'src_norma', 'Requisitos.'), clm('clm_b', 'src_loja', 'À venda.'), clm('clm_c', 'src_guia', 'Solteiro king mede 1,00 x 2,00 m.'), clm('clm_d', 'src_ficha', 'Mede 96 x 203 cm.')];
    const asked: string[][] = [];
    const decide: Decider = async (_state, questions) => {
      asked.push(Object.keys(questions));
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { choice: q.instructions.includes('Medidas de colchão') ? 'marca' : 'produto', probabilities: {}, confidence: 1 }]));
    };
    const out = await assignScopes(claims as never, sources as never, decide, 1);
    expect(out.get('clm_a')).toBe('geral');
    expect(out.get('clm_b')).toBe('produto');
    expect(out.get('clm_c')).toBe('marca');
    expect(out.get('clm_d')).toBe('produto');
    // Só as 2 de fabricante foram ao decisor, uma por lote (batch = 1).
    expect(asked).toEqual([['clm_c'], ['clm_d']]);
  });

  it('resposta fora do enum é ignorada', async () => {
    const sources = new Map([['src_guia', src('src_guia', 'manufacturer', 'Guia')]]);
    const decide: Decider = async () => ({ clm_c: { choice: 'talvez', probabilities: {}, confidence: 0.3 } });
    const out = await assignScopes([clm('clm_c', 'src_guia', 'x')] as never, sources as never, decide);
    expect(out.has('clm_c')).toBe(false);
  });

  it('a pergunta leva a paráfrase, o trecho, a fonte e o título do documento', () => {
    const q = scopeQuestion({ statement: 'S', quote: 'Q', claim_type: 'spec' } as never, { publisher: 'Castor', title: 'Medidas de colchão' } as never);
    expect(q.instructions).toContain('"S"');
    expect(q.instructions).toContain('Medidas de colchão');
    expect(Object.keys(q.criteria)).toEqual(['produto', 'marca', 'geral']);
    expect(scopeByClass({ source_class: 'manufacturer' } as never)).toBeNull();
  });
});
