import { describe, expect, it } from 'vitest';
import { spentToday, type LedgerEntry } from '../src/credits.ts';

// 27/10: o painel mostrava "199 de 250" e o gasto do dia tinha sido 384. O teto conta só os ciclos automáticos;
// ajuste, auditoria do site e imagem pedidos no painel ficam de fora. O gasto real sai do livro-caixa.

const e = (at: string, credits: number): LedgerEntry => ({ at, what: 'writer', model: 'm', credits, estimated: false });

describe('gasto real do dia', () => {
  const hoje = new Date('2026-10-27T17:00:00.000Z');

  it('soma tudo o que foi cobrado hoje, inclusive o que o teto não conta', () => {
    expect(spentToday([e('2026-10-27T01:00:00.000Z', 199), e('2026-10-27T16:00:00.000Z', 185.5)], hoje)).toBeCloseTo(384.5);
  });

  it('não traz o gasto de ontem nem o de amanhã', () => {
    expect(spentToday([e('2026-10-26T23:59:59.000Z', 100), e('2026-10-28T00:00:00.000Z', 100)], hoje)).toBe(0);
  });

  it('livro-caixa vazio é zero, não erro', () => {
    expect(spentToday([], hoje)).toBe(0);
  });
});
