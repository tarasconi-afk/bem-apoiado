import { describe, expect, it } from 'vitest';
import { fitDescription, makeDraftSchema } from '../src/stages/draft-schema.ts';
import { plainOutcome } from '../src/changes.ts';

// 06/11, como escolher cobertor: o redator devolveu a descrição para o Google com mais de 160 caracteres duas vezes,
// a página parou (SAFE_STOP) com a pesquisa pronta e 25,3 créditos saíram sem página.
describe('descrição longa não derruba o rascunho', () => {
  it('corta no fim da última frase que cabe', () => {
    const d = 'Escolha cobertor pela medida da cama e pela fibra declarada na etiqueta. Veja o que conferir no anúncio, como lavar e quando a gramatura ajuda a comparar dois modelos parecidos.';
    expect(d.length).toBeGreaterThan(160);
    expect(fitDescription(d)).toBe('Escolha cobertor pela medida da cama e pela fibra declarada na etiqueta.');
  });

  it('sem frase inteira que caiba, corta na vírgula ou palavra e não deixa conectivo solto', () => {
    const d = 'Escolha cobertor pela medida da cama, pela fibra declarada na etiqueta e pelos cuidados de lavagem que o fabricante informa para cada modelo vendido no Brasil hoje';
    const out = fitDescription(d) as string;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBeGreaterThanOrEqual(50);
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toMatch(/\s(e|de|para|com|que)\.$/);
    expect(d.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('não mexe na descrição que já cabe nem em valor que não é texto', () => {
    const ok = 'Como escolher cobertor: o que conferir na ficha e no anúncio antes de comprar.';
    expect(fitDescription(ok)).toBe(ok);
    expect(fitDescription(42)).toBe(42);
  });

  it('o schema aceita a descrição longa e entrega a encurtada', () => {
    const S = makeDraftSchema(['clm_aaaaaaaaaaaa']).shape.description;
    const r = S.safeParse('Escolha cobertor pela medida da cama e pela fibra declarada na etiqueta. ' + 'Confira também o que muda entre os modelos, a lavagem e a gramatura informada. '.repeat(2));
    expect(r.success).toBe(true);
    expect((r.data as string).length).toBeLessThanOrEqual(160);
  });

  it('o desfecho no painel diz que foi formato, não falta de fonte', () => {
    const o = plainOutcome(['page: SAFE_STOP (LLM_INVALID_OUTPUT: Claude Haiku 4.5 devolveu saída inválida duas vezes (page_draft))']);
    expect(o).toMatch(/fora do formato/);
    expect(o).toMatch(/^não virou página/);
  });
});
