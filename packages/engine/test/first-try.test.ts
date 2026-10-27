import { describe, expect, it } from 'vitest';
import { causeOfReview, causeOfSafeStop, summarize, trend, type Attempt } from '../src/first-try.ts';
import type { ReviewResult } from '../src/stages/review.ts';

// 27/10: a taxa agregada ("29% de aprovação de primeira") não dizia o que consertar; as oito causas daquele dia
// só apareceram abrindo run por run. Estes testes fixam o mapa de motivo → causa que o painel mostra.

const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  answers_primary_query: 'yes',
  concrete_guidance: true,
  reader_fit: true,
  quick_answer: true,
  purchase_path: true,
  reader_problems: [],
  filler_refs: [],
  decision_criteria: ['a', 'b', 'c'],
  missing: [],
  filler_ratio: 0.1,
  model_opinion: true,
  publishable: true,
  summary: '',
  ...over,
} as ReviewResult);

describe('causa de um SAFE_STOP', () => {
  it('separa os quatro motivos reais, que se consertam em lugares diferentes', () => {
    expect(causeOfSafeStop('AUDIT_NOT_CONVERGED')).toBe('auditoria não convergiu');
    expect(causeOfSafeStop('LLM_INVALID_OUTPUT: Claude Haiku devolveu saída inválida')).toBe('saída inválida do modelo');
    expect(causeOfSafeStop('LLM_HTTP: HTTP 524 cloudflare')).toBe('rede');
    expect(causeOfSafeStop('LLM_BUDGET_EXCEEDED: teto de 56.8 créditos atingido')).toBe('orçamento');
  });

  it('motivo desconhecido não some: cai em "outro"', () => {
    expect(causeOfSafeStop('algo novo')).toBe('outro');
  });
});

describe('causa de uma reprovação do juiz', () => {
  it('coerência vem antes das outras (é o que reprova com nota 4 de 4)', () => {
    const c = causeOfReview(review({ coherence: [{ check: 'secao_nao_entrega', ref: 'x#0', problem: 'p', fix: 'f' }] } as Partial<ReviewResult>));
    expect(c.cause).toBe('coerência');
    expect(c.detail).toContain('secao_nao_entrega');
  });

  it('revisão quando o juiz diz que a página não decide', () => {
    expect(causeOfReview(review({ answers_primary_query: 'no' })).cause).toBe('revisão');
  });

  it('regra quando passou no juiz mas caiu no enchimento ou nos critérios', () => {
    expect(causeOfReview(review({ filler_ratio: 0.5, decision_criteria: [] })).cause).toBe('regra');
  });
});

const at = (run: string, cause: Attempt['cause'], ms: number): Attempt => ({ run, at: ms, cause, detail: '' });

describe('resumo e tendência', () => {
  const dia = 86_400_000;
  const agora = 1_000 * dia;
  const list = [
    at('a', 'aprovada', agora - 10 * dia),
    at('b', 'coerência', agora - 10 * dia),
    at('c', 'coerência', agora - 2 * dia),
    at('d', 'aprovada', agora - 1 * dia),
  ];

  it('a taxa conta só as aprovadas', () => {
    expect(summarize(list).rate).toBe(0.5);
    expect(summarize(list).passed).toBe(2);
  });

  it('a lista de causas traz só reprovação, da mais frequente para a menos', () => {
    const by = summarize(list).byCause;
    expect(by.map(([c]) => c)).not.toContain('aprovada');
    expect(by[0]).toEqual(['coerência', 2]);
  });

  it('sem tentativa, a taxa é nula em vez de 0% (0 de 0 não é reprovação)', () => {
    expect(summarize([]).rate).toBeNull();
  });

  it('a janela curta separa o que veio depois de uma correção', () => {
    const t = trend(list, 7, agora);
    expect(t.recent.total).toBe(2);
    expect(t.before.total).toBe(2);
    expect(t.recent.rate).toBe(0.5);
  });

  // Num projeto de 7 dias, "todo o resto" eram 7 tentativas contra 57, e a comparação dizia que o motor tinha
  // piorado quando só estava comparando tamanhos diferentes.
  it('a janela anterior é fechada, do mesmo tamanho, e não "todo o resto"', () => {
    const velho = [...list, at('e', 'aprovada', agora - 40 * dia), at('f', 'aprovada', agora - 60 * dia)];
    const t = trend(velho, 7, agora);
    expect(t.before.total).toBe(2);
  });
});
