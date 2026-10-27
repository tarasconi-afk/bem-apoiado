import { describe, expect, it } from 'vitest';
import { ruleClaimIds, selectClaims } from '../src/stages/draft-schema.ts';
import { claimScope } from '../src/stages/write.ts';

const id = (i: number) => `clm_${String(i).padStart(12, '0')}`;

describe('evidências para o redator (27/10)', () => {
  it('reveza por pergunta: a pergunta com poucas evidências não fica de fora', () => {
    // 50 evidências de garantia (q1) e 10 de medidas (q2), mesma fonte, 30 vagas: antes, a pontuação igual deixava
    // a ordem do id decidir e as 10 de medidas podiam ficar todas de fora.
    const topic = { questions: [{ id: 'q1', text: 'garantia' }, { id: 'q2', text: 'medidas' }], source_ids: ['s1'], focus_terms: [], editorial_notes: [] } as never;
    const claims = Array.from({ length: 60 }, (_, i) => ({ id: id(i), source_id: 's1', quote: 'x', question_ids: i < 50 ? ['q1'] : ['q2'] })) as never[];
    const out = selectClaims(topic, claims, () => 'manufacturer', new Set(), 30);
    expect(out).toHaveLength(30);
    expect(out.filter((c: { question_ids: string[] }) => c.question_ids.includes('q2'))).toHaveLength(10);
  });

  it('as evidências das regras de decisão entram sempre', () => {
    const topic = { questions: [{ id: 'q1', text: 'x' }], source_ids: ['s1'], focus_terms: [], editorial_notes: [`Regra de decisão sustentada: Se você…, escolha… (evidências: ${id(59)}, ${id(58)})`] } as never;
    const claims = Array.from({ length: 60 }, (_, i) => ({ id: id(i), source_id: 's1', quote: 'x', question_ids: ['q1'] })) as never[];
    expect([...ruleClaimIds(topic)]).toEqual([id(59), id(58)]);
    const out = selectClaims(topic, claims, () => 'manufacturer', new Set(), 20).map((c: { id: string }) => c.id);
    expect(out).toContain(id(59));
    expect(out).toContain(id(58));
    expect(out).toHaveLength(20);
  });

  it('fichas que repetem os mesmos números entram no máximo 2 vezes; guia da marca pontua mais', () => {
    // 40 fichas Probel "viúva mede 128 × 188" (q1, citam o termo de foco) e 1 guia da Castor com os tamanhos (q1, sem o
    // termo de foco): com 10 vagas, o guia entra e as fichas iguais ficam em 2.
    const topic = { questions: [{ id: 'q1', text: 'medidas' }], source_ids: ['probel', 'castor'], focus_terms: ['viúva'], editorial_notes: [] } as never;
    const claims = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: id(i), source_id: 'probel', quote: 'colchão viúva', statement: `O colchão viúva ${'M' + 'a'.repeat(i)} mede 128 × 188 cm.`, claim_type: 'spec', question_ids: ['q1'] })),
      { id: id(90), source_id: 'castor', quote: 'solteiro king 1,00 x 2,00', statement: 'Solteiro king mede 1,00 x 2,00 m segundo a Castor.', claim_type: 'spec', scope: 'marca', question_ids: ['q1'] },
      ...Array.from({ length: 20 }, (_, i) => ({ id: id(100 + i), source_id: 'probel', quote: 'garantia', statement: `Garantia de ${i + 1} meses.`, claim_type: 'spec', question_ids: ['q1'] })),
    ] as never[];
    const out = selectClaims(topic, claims, () => 'manufacturer', new Set(), 10) as { id: string; statement: string }[];
    expect(out.map((c) => c.id)).toContain(id(90));
    expect(out.filter((c) => c.statement.includes('128 × 188'))).toHaveLength(2);
    expect(out).toHaveLength(10);
  });

  it('alcance decidido na extração vence a dedução pelo tipo', () => {
    expect(claimScope({ claim_type: 'spec', scope: 'marca' }, { source_class: 'manufacturer' })).toContain('guia ou tabela da marca');
    expect(claimScope({ claim_type: 'spec', scope: 'produto' }, { source_class: 'manufacturer' })).toContain('SÓ O PRODUTO');
    expect(claimScope({ claim_type: 'spec', scope: 'geral' }, { source_class: 'manufacturer' })).toContain('regra geral');
    expect(claimScope({ claim_type: 'spec' }, { source_class: 'manufacturer' })).toContain('SÓ O PRODUTO');
  });
});
