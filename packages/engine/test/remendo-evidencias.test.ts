import { describe, expect, it } from 'vitest';
import type { Claim } from '@bem-apoiado/core';
import { claimsForPatch } from '../src/stages/patch.ts';
import type { Draft } from '../src/stages/draft-schema.ts';

// 05/11: o remendo de um bloco levava as 133 evidências da pauta (~7 créditos por chamada).
const id = (n: number) => `clm_${n.toString(16).padStart(12, '0')}`;
const claim = (n: number, statement: string): Claim =>
  ({ id: id(n), source_id: 'src_aaaaaaaaaaaa', quote: statement, statement, claim_type: 'spec', captured_at: '2026-11-05T00:00:00.000Z', question_ids: [] }) as Claim;

describe('evidências de um remendo', () => {
  const claims = Array.from({ length: 100 }, (_, i) => claim(i + 1, `Ficha genérica número ${i + 1} sobre garantia e embalagem`));
  claims.push(claim(500, 'Pillow top é uma camada extra de conforto colocada sobre o colchão'));
  const draft = {
    title: 'Pillow top',
    verdict: { text: 'Resposta', basis: 'evidence', claim_ids: [id(7)] },
    sections: [
      { id: 'o-que-e', heading: 'O que é', blocks: [{ kind: 'paragraph', text: 'Espuma de alta resiliência.', basis: 'evidence', claim_ids: [id(3)] }] },
      { id: 'garantia', heading: 'Garantia', blocks: [{ kind: 'paragraph', text: 'Garantia de 90 dias.', basis: 'evidence', claim_ids: [id(9)] }] },
    ],
  } as unknown as Draft;
  const issues = [{ ref: 'o-que-e#0', msg: `Explique a camada extra de conforto sobre o colchão; use ${id(42)}` }];

  it('mantém as citadas na seção tocada e as citadas pelo id, e corta o resto até o teto', () => {
    const sub = claimsForPatch(claims, draft, ['o-que-e#0'], issues, 10);
    const ids = sub.map((c) => c.id);
    expect(sub).toHaveLength(10);
    expect(ids).toContain(id(3)); // citada no bloco
    expect(ids).toContain(id(42)); // citada no pedido
    expect(ids[2]).toBe(id(500)); // a mais próxima do problema vem logo depois das obrigatórias
    expect(ids).not.toContain(id(90)); // o resto, sem relação com o bloco, fica de fora
  });

  it('pauta pequena passa inteira', () => {
    expect(claimsForPatch(claims.slice(0, 20), draft, ['o-que-e#0'], issues)).toHaveLength(20);
  });
});
