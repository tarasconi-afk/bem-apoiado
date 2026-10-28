import { describe, expect, it } from 'vitest';
import { styleIssues } from '../src/stages/page.ts';

// 28/10, "travesseiro de pena de ganso ou de fibra": a tabela do Como decidir tinha duas linhas "Enchimento", a
// segunda só acrescentando "Segundo a Ortobom:". O juiz marcou uma como enchimento e nenhum gate pegava.

const cel = (text: string) => ({ text, claim_ids: [] });
const pagina = (rows: string[][]) => ({
  title: 'Guia',
  description: 'd',
  verdict: { text: 'Escolha X se A, e Y se B. Confira a ficha antes de comprar.', basis: 'reasoning', claim_ids: [] },
  sections: [
    { id: 'tipos', heading: 'Tipos', blocks: [{ kind: 'paragraph', text: 'Um parágrafo com conteúdo suficiente para o gate de forma não reclamar do tamanho.', basis: 'evidence', claim_ids: [] }] },
    { id: 'detalhes', heading: 'Detalhes', blocks: [{ kind: 'paragraph', text: 'Outro parágrafo de apoio com informação que o comprador usa para decidir.', basis: 'evidence', claim_ids: [] }] },
    { id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'table', caption: 'Comparação', columns: ['Característica', 'Opção A', 'Opção B'], rows: rows.map((r) => ({ cells: r.map(cel) })) }] },
  ],
}) as never;

const repetidas = (rows: string[][]) => styleIssues(pagina(rows)).filter((i) => /diz o mesmo que a linha/.test(i.msg));

describe('linha de tabela repetida', () => {
  it('pega a linha que só acrescenta a atribuição', () => {
    const r = repetidas([
      ['Enchimento', 'fibra siliconada 100% poliéster', '100% plumas de ganso'],
      ['Enchimento', 'Segundo a Ortobom: fibra siliconada 100% poliéster', 'Segundo a Ortobom: 100% plumas de ganso'],
      ['Lavagem', 'permitida a 40°C', 'proibida'],
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.ref).toBe('como-decidir#0.r1');
  });

  // Numa tabela cuja 1ª coluna é o fabricante, repetir a marca é legítimo: o que muda é o modelo.
  it('não reclama de duas linhas do mesmo fabricante com modelos diferentes', () => {
    expect(repetidas([
      ['Probel', 'Espuma D15', '14 cm'],
      ['Probel', 'Visco Gel D40', '12 cm'],
    ])).toHaveLength(0);
  });

  it('linhas diferentes continuam passando', () => {
    expect(repetidas([
      ['Enchimento', 'fibra siliconada', 'plumas de ganso'],
      ['Lavagem', 'permitida a 40°C', 'proibida'],
    ])).toHaveLength(0);
  });
});
