import { describe, expect, it } from 'vitest';
import { decisionIssues } from '../src/stages/page.ts';

const para = (text: string, claim_ids = ['c1']) => ({ kind: 'paragraph' as const, text, basis: 'claim' as const, claim_ids });
const table = (rows: string[][], caption = 'Medidas por tamanho', claim_ids = ['c1']) => ({ kind: 'table' as const, caption, columns: ['Tamanho', 'Medida'], rows: rows.map((r) => ({ cells: r.map((text) => ({ text, claim_ids })) })) });
const draft = (over: object) => ({ title: 'Colchão solteirão ou viúva: qual tamanho escolher', description: 'x', verdict: { text: 'Solteiro mede 88 × 188 cm. Viúva mede 128 × 188 cm.', claim_ids: ['c1'] }, sections: [
  { id: 'a', heading: 'Medidas', blocks: [para('Texto.')] },
  { id: 'como-decidir', heading: 'Como decidir', blocks: [para('Se você tem espaço para 88 cm de largura no quarto ou na base: o solteiro mede 88 × 188 cm.'), para('Se você tem espaço para 88 cm de largura: o solteiro mede 88 × 188 cm.'), table([['Solteiro', '88 × 188 cm']])] },
], ...over }) as never;

describe('regras de decisão (página rasa do solteirão, 23/10)', () => {
  it('pega opção do título sem resposta, tabela de uma linha e condição repetida', () => {
    const msgs = decisionIssues(draft({})).map((i) => `${i.ref}: ${i.msg}`);
    expect(msgs.some((m) => m.startsWith('verdict') && m.includes('colchao solteirao'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('como-decidir#2') && m.includes('uma linha só'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('como-decidir#1') && m.includes('repete a condição de como-decidir#0'))).toBe(true);
  });
  it('página que responde às duas opções, com tabela de várias linhas, passa', () => {
    const ok = draft({ verdict: { text: 'Solteirão mede 100 × 200 cm, segundo a Probel; viúva mede 128 × 188 cm.', claim_ids: ['c1'] }, sections: [
      { id: 'a', heading: 'Medidas', blocks: [para('Texto.')] },
      { id: 'como-decidir', heading: 'Como decidir', blocks: [para('Se você dorme sozinho e é alto: o solteirão tem 200 cm.'), table([['Solteirão', '100 × 200 cm'], ['Viúva', '128 × 188 cm']])] },
    ] });
    expect(decisionIssues(ok)).toEqual([]);
  });
  it('"padrão" sustentado só por ficha de produto é recusado; com norma ou definição, passa', () => {
    const d = draft({ verdict: { text: 'Solteirão e viúva: veja abaixo.', claim_ids: ['c1'] }, sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [table([['Solteirão', '100 × 200'], ['Viúva', '128 × 188']], 'Medidas padrão por tamanho')] }] });
    expect(decisionIssues(d, () => 'spec').some((i) => i.msg.includes('"padrao"'))).toBe(true);
    expect(decisionIssues(d, () => 'regulation').some((i) => i.msg.includes('"padrao"'))).toBe(false);
  });
});
