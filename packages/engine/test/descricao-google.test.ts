import { describe, expect, it } from 'vitest';
import { applyPatches } from '../src/stages/patch.ts';
import { descriptionNumbers, neutralDescription, styleIssues } from '../src/stages/page.ts';
import { applyTextEdits } from '../src/stages/manual-edit.ts';

// 05/11: a descrição não tem fonte e nunca passou pelo auditor. O rascunho do lençol solteirão afirmava uma medida
// que era de outro tamanho; 9 páginas no ar viravam dado de um fabricante em regra geral.
describe('descrição para o Google', () => {
  it('número que não está no título é barrado; o do título é o nome da dúvida', () => {
    expect(descriptionNumbers({ title: 'Lençol solteirão: qual a medida exata', description: 'Lençol solteirão para colchão 1,00 × 2,00 m: medidas sem elástico 1,50 × 2,40 m; com elástico, confira altura máxima na ficha.' }))
      .toEqual(['1,00', '2,00', '1,50', '2,40']);
    expect(descriptionNumbers({ title: 'Colchão D33 ou D45: qual escolher', description: 'Como decidir entre D33 e D45 pelo seu peso e pela firmeza que prefere, conferindo a ficha do fabricante.' })).toEqual([]);
  });

  it('o problema aponta a descrição, não a página inteira (remendo barato, sem reescrita)', () => {
    const d = { title: 'Lençol solteirão: qual a medida', description: 'Lençol solteirão mede 1,50 × 2,40 m; confira a altura da aba na ficha do produto.', verdict: { text: 'Confira a medida.', basis: 'evidence', claim_ids: ['clm_aaaaaaaaaaaa'] }, sections: [] };
    expect(styleIssues(d as never).filter((i) => i.ref === 'description')).toHaveLength(1);
  });

  it('o remendo troca a descrição dentro de 50 a 160 caracteres', () => {
    const base = { title: 't', description: 'antiga'.repeat(10), verdict: { text: 'v', basis: 'evidence', claim_ids: [] }, sections: [] };
    const nova = 'O que conferir na ficha do lençol solteirão para acertar a medida e a altura da aba.';
    expect(applyPatches(base as never, [{ ref: 'description', action: 'replace', text: nova }] as never).description).toBe(nova);
    expect(applyPatches(base as never, [{ ref: 'description', action: 'replace', text: 'curta' }] as never).description).toBe(base.description);
  });

  it('a descrição neutra cabe nos limites e não tem número', () => {
    for (const t of ['Pillow top: o que é e vale a pena comprar', 'Cetim ou percal: qual escolher pela tecelagem e contagem de fios e mais um pedaço longo']) {
      const n = neutralDescription(t);
      expect(n.length).toBeGreaterThanOrEqual(50);
      expect(n.length).toBeLessThanOrEqual(160);
      expect(descriptionNumbers({ title: t, description: n })).toEqual([]);
    }
  });

  it('a edição do painel aceita título e descrição', () => {
    const base = { title: 'Antigo', description: 'd'.repeat(60), verdict: { text: 'v', basis: 'evidence', claim_ids: [] }, sections: [] };
    const r = applyTextEdits(base as never, { title: 'Colchão misto: o que é e quando escolher', description: 'nova descrição '.repeat(5) });
    expect(r.changed).toEqual(['title', 'description']);
    expect(r.draft.title).toBe('Colchão misto: o que é e quando escolher');
  });
});
