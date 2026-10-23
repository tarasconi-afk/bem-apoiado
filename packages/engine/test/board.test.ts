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
