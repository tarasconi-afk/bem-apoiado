import { describe, expect, it } from 'vitest';
import { recheckDays } from '../src/stages/site-audit.ts';
import type { CoherenceFinding } from '../src/stages/coherence.ts';

const f = (): CoherenceFinding => ({ check: 'secao_nao_entrega', ref: 'tipos#0', problem: 'p', fix: 'mudar o título' });

// 27/10: três páginas tiveram o ajuste da auditoria descartado porque ele apagava evidência. Elas ficaram
// marcadas como auditadas no dia e sumiriam da fila por 14 dias, com o problema ainda no ar.
describe('quando a página volta para a fila da auditoria', () => {
  it('página limpa espera os 14 dias', () => {
    expect(recheckDays([])).toBe(14);
  });

  it('página com achado aberto volta em 2 dias', () => {
    expect(recheckDays([f()])).toBe(2);
  });

  it('com achado sempre volta antes da página limpa', () => {
    expect(recheckDays([f()])).toBeLessThan(recheckDays([]));
  });
});
