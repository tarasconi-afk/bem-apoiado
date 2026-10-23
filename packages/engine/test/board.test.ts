import { describe, expect, it } from 'vitest';
import { classifyBranch, classifyDraft, correctionText } from '../src/board.ts';

const rv = (publishable: boolean, extra = {}) => ({ publishable, answers_primary_query: 'yes', reader_fit: true, quick_answer: true, purchase_path: true, missing: [], reader_problems: [], ...extra });

describe('quadro de decisões', () => {
  it('página nova aprovada pela revisão: publicar', () => {
    const c = classifyBranch({ slug: 'x', items: [{ id: 'page:x', title: 'Página nova no ar: X' }, { id: 'images', title: 'Imagens' }], query: 'x', outcome: null, steps: [], review: rv(true), failedAdjust: false });
    expect([c.kind, c.suggestion]).toEqual(['pagina-nova', 'publicar']);
  });
  it('página nova com revisão fraca: corrigir, com texto pronto', () => {
    const c = classifyBranch({ slug: 'x', items: [{ id: 'page:x', title: 'Página nova no ar: X' }], query: 'x', outcome: null, steps: [], review: rv(false, { quick_answer: false, reader_problems: ['A resposta curta não diz qual escolher'] }), failedAdjust: false });
    expect(c.suggestion).toBe('corrigir');
    expect(c.correction).toContain('1) A resposta curta não diz qual escolher');
    expect(c.why).toContain('resposta rápida: não');
  });
  it('ajuste em página no ar: aplicar se a revisão aprova; corrigir com texto pronto se ainda fraca', () => {
    const items = [{ id: 'page:x', title: 'Texto de "X": 3 trecho(s) alterado(s)' }];
    expect(classifyBranch({ slug: 'x', items, outcome: null, steps: [], review: rv(true), failedAdjust: false }).suggestion).toBe('aplicar');
    const c = classifyBranch({ slug: 'x', items, outcome: null, steps: [], review: rv(false, { answers_primary_query: 'partial', reader_problems: ['Não diz quando escolher cada tipo'] }), failedAdjust: false });
    expect([c.kind, c.suggestion]).toEqual(['ajuste-no-ar', 'corrigir']);
    expect(c.correction).toContain('Não diz quando escolher cada tipo');
  });
  it('só capa e produtos: manutenção para aplicar', () => {
    const c = classifyBranch({ slug: 'y', items: [{ id: 'images', title: 'Imagens' }, { id: 'product:B01', title: 'Novo exemplo' }], outcome: null, steps: [], review: null, failedAdjust: false });
    expect([c.kind, c.suggestion]).toEqual(['manutencao', 'aplicar']);
    expect(c.situation).toContain('imagem nova, 1 produto(s)');
  });
  it('pauta adiada: nada a fazer, com o que falta', () => {
    const c = classifyBranch({ slug: 'p', items: [], query: 'protetor', outcome: 'não virou página, por isso não há prévia: … Falta: fonte que diga o que o protetor resolve. Nada…', steps: ['pauta adiada antes da redação: x'], review: null, failedAdjust: false });
    expect([c.kind, c.suggestion]).toEqual(['pauta-tentada', 'nada']);
    expect(c.situation).toContain('Adiada');
    expect(c.why).toBe('fonte que diga o que o protetor resolve');
  });
  it('rascunho: aprovar quando a revisão aprova; recusar quando reprova sem o que corrigir; corrigir se o ajuste falhou', () => {
    expect(classifyDraft({ review: rv(true), failedAdjust: false }).suggestion).toBe('aprovar');
    expect(classifyDraft({ review: rv(false), failedAdjust: false }).suggestion).toBe('recusar');
    expect(classifyDraft({ review: rv(true), failedAdjust: true }).suggestion).toBe('corrigir');
    expect(correctionText(null)).toBe('');
  });
});

describe('todo desfecho de pauta tem explicação', () => {
  it('auditoria travada e nova tentativa sem fonte viram cartão informativo com texto simples', async () => {
    const { plainOutcome } = await import('../src/changes.ts');
    const safe = plainOutcome(['pauta nova: "pillow top" (6 perguntas)', 'page: SAFE_STOP (AUDIT_NOT_CONVERGED)']);
    expect(safe).toContain('o auditor achou afirmações sem fonte');
    const imp = plainOutcome(['pauta "pillow top": nova tentativa (já existia)', 'improve: NO_NEW_SOURCES: a busca direcionada não achou fonte nova aceita']);
    expect(imp).toContain('não achou fonte nova');
    const c = classifyBranch({ slug: 'p', items: [], query: 'pillow top', outcome: safe, steps: ['page: SAFE_STOP (AUDIT_NOT_CONVERGED)'], review: null, failedAdjust: false });
    expect([c.kind, c.suggestion]).toEqual(['pauta-tentada', 'nada']);
    expect(c.situation).toMatch(/^Não virou página/);
  });
});

describe('melhoria contínua', () => {
  it('correção sugerida traz as regras das fontes antes dos problemas', async () => {
    const { correctionText, rulesFromNotes } = await import('../src/board.ts');
    const rules = rulesFromNotes(['Regra de decisão sustentada: Se a altura for limitada, prefira sem pillow top. (evidências: clm_a, clm_b)', 'outra nota']);
    expect(rules).toEqual(['Se a altura for limitada, prefira sem pillow top']);
    const t = correctionText({ publishable: false, reader_problems: ['Termos sem explicação.'] }, rules);
    expect(t).toMatch(/^Reescreva a resposta curta e o Como decidir com estas regras, que as fontes já sustentam: 1\) Se a altura/);
    expect(t).toContain('Resolva também: a) Termos sem explicação.');
  });
  it('nota de leitor: em parte vale meio; cada "não" tira um ponto', async () => {
    const { readerScore } = await import('../src/stages/review.ts');
    expect(readerScore({ answers_primary_query: 'yes', reader_fit: true, quick_answer: true, purchase_path: true })).toBe(4);
    expect(readerScore({ answers_primary_query: 'partial', reader_fit: false, quick_answer: false, purchase_path: false })).toBe(0.5);
  });
  it('cartão de rascunho conta a correção automática', async () => {
    const { classifyBranch } = await import('../src/board.ts');
    const c = classifyBranch({ slug: 'p', items: [], query: 'pillow top', outcome: null, steps: ['page: NOT_PUBLISHABLE', 'correção automática do rascunho: aplicada (nota de leitor 0.5 → 3 de 4)'], review: null, failedAdjust: false });
    expect(c.situation).toContain('o motor já tentou uma correção automática: aplicada (nota de leitor 0.5 → 3 de 4)');
  });
});
