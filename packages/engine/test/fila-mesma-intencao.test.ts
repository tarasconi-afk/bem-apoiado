import { describe, expect, it } from 'vitest';
import { recusaDaFila } from '../src/stages/autopilot.ts';

describe('fila recusa pauta de mesma intenção (12/11)', () => {
  const conhecidas = [
    { label: 'Pillow top: o que é e vale a pena?', slug: 'pillow-top-o-que-e-e-vale-a-pena' },
    { label: 'suporte para notebook: qual escolher', slug: 'suporte-para-notebook-qual-escolher' },
  ];
  it('recusa as duas da auditoria com o motivo', () => {
    expect(recusaDaFila('pillow top', conhecidas)).toBe('mesma intenção de pillow-top-o-que-e-e-vale-a-pena');
    expect(recusaDaFila('suporte para notebook vale a pena', conhecidas)).toBe('mesma intenção de suporte-para-notebook-qual-escolher');
  });
  it('dúvida nova passa', () => {
    expect(recusaDaFila('colchão para beliche: qual altura', conhecidas)).toBeNull();
  });
});
