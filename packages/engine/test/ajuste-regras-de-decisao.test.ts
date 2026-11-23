import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-ajuste-dec-'));
const { issuesParaCorrigir } = await import('../src/stages/requests.ts');

// 23/11: o ajuste do cobertor king/queen foi barrado 2x por "repete a condição" sem nunca voltar ao redator.
const p = (text: string, ids: string[] = ['c1']) => ({ kind: 'paragraph', text, basis: 'evidence', claim_ids: ids });
const draft = {
  title: 'Cobertor king ou queen: qual é maior',
  description: 'x',
  verdict: { text: 'O king é maior. Escolha pelo tamanho da cama, king para king e queen para queen.', basis: 'evidence', claim_ids: ['c1'] },
  sections: [
    { id: 'como-decidir', heading: 'Como decidir', blocks: [
      p('Se você tem cama king, compre o cobertor king, que a Döhler indica para essa cama.'),
      p('Se você tem cama king grande, prefira o king de 2,80 m, segundo a Plumasul.'),
      p('As medidas são o padrão do mercado, segundo a Corttex.', ['spec1']),
    ] },
  ],
} as never;
const tipo = (id: string) => (id === 'spec1' ? 'spec' : 'fact');

describe('regras de decisão voltam ao redator no ajuste (23/11)', () => {
  it('condição repetida e "padrão" de ficha em bloco tocado entram na lista de correção', () => {
    const msgs = issuesParaCorrigir(draft, new Set(['como-decidir#1', 'como-decidir#2']), tipo).map((i) => `${i.ref} ${i.msg}`);
    expect(msgs.some((m) => m.startsWith('como-decidir#1 repete a condição'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('como-decidir#2 chama de "padrao"'))).toBe(true);
  });
  it('bloco que o ajuste não tocou não é cobrado', () => {
    expect(issuesParaCorrigir(draft, new Set(['verdict']), tipo).filter((i) => i.ref !== 'verdict')).toEqual([]);
  });
});
