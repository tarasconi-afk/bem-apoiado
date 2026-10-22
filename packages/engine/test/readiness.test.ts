import { describe, expect, it } from 'vitest';

describe('regras de escolha antes da redação', () => {
  it('só conta regra com evidência de fabricante/teste/norma e sem linguagem de posto de trabalho', async () => {
    const { buyerRules } = await import('../src/stages/readiness.ts');
    const cls: Record<string, string> = { fab: 'manufacturer', reg: 'regulator', abnt: 'standard_body' };
    const rules = [
      { rule: 'Se você divide a cama, escolha molas ensacadas.', claim_ids: ['fab'] },
      { rule: 'Se você alterna sentado e em pé, a NR-17 orienta mesa regulável.', claim_ids: ['fab'] },
      { rule: 'Se você quer o selo, confira o Inmetro.', claim_ids: ['reg'] },
      { rule: 'Se você pesa mais de 100 kg, confira a norma de densidade.', claim_ids: ['reg', 'abnt'] },
    ];
    expect(buyerRules(rules, (id) => cls[id]).map((r) => r.claim_ids.join())).toEqual(['fab', 'reg,abnt']);
  });
});
