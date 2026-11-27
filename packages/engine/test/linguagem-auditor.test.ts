import { describe, expect, it } from 'vitest';
import { styleIssues } from '../src/stages/page.ts';

// 25/11: 9 páginas no ar tinham vocabulário do motor que a regra antiga ("trechos citados") não via.
const pagina = (texto: string) => ({
  title: 'Guia',
  description: 'd',
  verdict: { text: 'Escolha X se A, e Y se B. Confira a ficha antes de comprar.', basis: 'reasoning', claim_ids: [] },
  sections: [{ id: 'carga', heading: 'Carga', blocks: [{ kind: 'paragraph', text: texto, basis: 'evidence', claim_ids: [] }] }],
}) as never;
const vazou = (t: string) => styleIssues(pagina(t)).filter((i) => i.ref === 'carga#0' && /termo do motor/.test(i.msg));

describe('linguagem do auditor no texto da página', () => {
  it.each([
    'Nas fichas citadas da Probel, a capacidade é de 150 kg por pessoa.',
    'O trecho menciona especificamente que pessoas altas tendem a ter mais massa.',
    'Os trechos consultados não mencionam D45.',
    'Nos trechos da Karsten, aparecem poliéster e algodão.',
    'Segundo os trechos citados, a Ortobom declara 80 kg.',
    'A marca descreve uma densidade robusta, sem que o excerto citado informe qual é ela.',
    'Um texto mais estreito seria: “Um modelo Castor combina espumas D45 e D20.”',
  ])('pega: %s', (t) => expect(vazou(t)).toHaveLength(1));
  it('não reclama de texto normal', () => {
    expect(vazou('Na ficha da Probel, a capacidade é de 150 kg por pessoa.')).toHaveLength(0);
  });
});
