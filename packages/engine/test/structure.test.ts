import { describe, expect, it } from 'vitest';
import { applyMoves, decisionLast, dropClaimless } from '../src/stages/structure.ts';

const txt = (text: string, claim_ids = ['c']) => ({ kind: 'text', text, basis: 'evidence', claim_ids }) as never;
const tab = (caption: string) => ({ kind: 'table', caption, columns: ['a', 'b'], rows: [] }) as never;
const page = () => ({
  title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
  sections: [
    { id: 'como-decidir', heading: 'Como decidir: escolha pela faixa de peso', blocks: [tab('Densidade por peso'), txt('A')] },
    { id: 'o-que-e', heading: 'O que é densidade', blocks: [txt('B')] },
    { id: 'etiqueta', heading: 'O que conferir na etiqueta antes de comprar', blocks: [txt('C'), txt('D')] },
  ],
}) as never;

describe('estrutura sem IA', () => {
  it('"Como decidir" vai para o fim (o site mostra a última seção no topo)', () => {
    expect(decisionLast(page()).sections.map((s) => s.id)).toEqual(['o-que-e', 'etiqueta', 'como-decidir']);
  });
  it('move a tabela para depois do 1º bloco da seção de destino, sem mexer no conteúdo', () => {
    const r = applyMoves(page(), [{ ref: 'como-decidir#0', to: 'etiqueta', position: 'after_first' }]);
    const et = r.draft.sections.find((s) => s.id === 'etiqueta')!;
    expect(et.blocks.map((b) => (b.kind === 'table' ? `T:${b.caption}` : b.text))).toEqual(['C', 'T:Densidade por peso', 'D']);
    expect(r.done).toEqual(['como-decidir#0 → etiqueta']);
  });
  it('ignora movimento para a própria seção ou ref inexistente', () => {
    expect(applyMoves(page(), [{ ref: 'etiqueta#0', to: 'etiqueta', position: 'end' }, { ref: 'x#9', to: 'etiqueta', position: 'end' }]).done).toEqual([]);
  });
  it('descarta só bloco tocado e sem fonte', () => {
    const d = page() as { sections: { blocks: unknown[] }[] };
    d.sections[2]!.blocks.push(txt('sem fonte', []));
    const r = dropClaimless(d as never, new Set(['etiqueta#2']));
    expect(r.dropped).toEqual(['etiqueta#2']);
    expect(r.draft.sections[2]!.blocks).toHaveLength(2);
  });
});

describe('tabela leva o parágrafo que a apresenta', () => {
  it('parágrafo curto logo antes da tabela vai junto, na mesma ordem', () => {
    const d = {
      title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
      sections: [
        { id: 'medidas', heading: 'Medidas', blocks: [txt('Confira a ficha técnica do modelo.'), tab('Medidas por tamanho')] },
        { id: 'outra', heading: 'Outra', blocks: [txt('B')] },
        { id: 'mais', heading: 'Mais', blocks: [txt('E')] },
        { id: 'decidir', heading: 'O que conferir antes de comprar', blocks: [txt('C')] },
      ],
    } as never;
    const r = applyMoves(d, [{ ref: 'medidas#1', to: 'decidir', position: 'end' }]);
    const dec = r.draft.sections.find((s) => s.id === 'decidir')!;
    expect(dec.blocks.map((b) => (b.kind === 'table' ? 'T' : b.text))).toEqual(['C', 'Confira a ficha técnica do modelo.', 'T']);
    expect(r.draft.sections.map((s) => s.id)).toEqual(['outra', 'mais', 'decidir']);
  });
});

describe('parágrafo de abertura leva a tabela', () => {
  it('apontar o parágrafo curto antes da tabela move os dois', () => {
    const d = {
      title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] },
      sections: [
        { id: 'medidas', heading: 'Medidas', blocks: [txt('Confira a ficha técnica do modelo.'), tab('Medidas')] },
        { id: 'a', heading: 'A', blocks: [txt('B')] }, { id: 'b', heading: 'B', blocks: [txt('E')] },
        { id: 'decidir', heading: 'Decidir', blocks: [txt('C')] },
      ],
    } as never;
    const dec = applyMoves(d, [{ ref: 'medidas#0', to: 'decidir', position: 'end' }]).draft.sections.at(-1)!;
    expect(dec.blocks.map((b) => (b.kind === 'table' ? 'T' : b.text))).toEqual(['C', 'Confira a ficha técnica do modelo.', 'T']);
  });
});

describe('Como decidir em 1º não trava a página', () => {
  it('depois de decisionLast, a regra da última seção não acusa', async () => {
    const { styleIssues } = await import('../src/stages/page.ts');
    const d = page();
    const msg = (x: never) => styleIssues(x).filter((i) => i.msg.startsWith('a última seção')).length;
    const before = { ...(d as object), sections: [(d as { sections: unknown[] }).sections[0], (d as { sections: unknown[] }).sections[1], { id: 'garantia', heading: 'O que a garantia cobre', blocks: [txt('G')] }] } as never;
    expect(msg(before)).toBe(1);
    expect(msg(decisionLast(before) as never)).toBe(0);
  });
});

describe('atribuição por código', () => {
  it('fabricante único sem nome ganha "segundo a X"; já citado, norma junto ou framing não mudam', async () => {
    const { attributeSingleSource } = await import('../src/stages/structure.ts');
    const src: Record<string, { publisher: string; source_class: string }> = { e: { publisher: 'ergocadeiras', source_class: 'manufacturer' }, f: { publisher: 'Flexform', source_class: 'manufacturer' }, n: { publisher: 'ABNT', source_class: 'standard_body' } };
    const t = (text: string, ids: string[], basis = 'evidence') => ({ kind: 'paragraph', text, basis, claim_ids: ids });
    const d = {
      title: 't', description: 'd', verdict: { text: 'Se você pesa mais de 110 kg, evite nylon. Confira a base.', basis: 'evidence', claim_ids: ['e'] },
      sections: [{ id: 's', heading: 'S', blocks: [
        t('A Classe 4 suporta 150 kg.', ['e']),
        t('Segundo a ergocadeiras, a base de aço é mais firme.', ['e']),
        t('A norma exige ensaio de base.', ['e', 'n']),
        t('Compare as fichas das duas marcas.', ['e', 'f']),
        t('Veja a seguir os detalhes de cada item da ficha.', [], 'framing'),
        { kind: 'table', caption: 'Peso suportado', columns: ['a', 'b'], rows: [{ cells: [{ text: 'x', claim_ids: ['e'] }, { text: 'y', claim_ids: ['e'] }] }] },
      ] }],
    } as never;
    const r = attributeSingleSource(d, (id) => src[id]);
    const b = (r.draft as any).sections[0].blocks;
    expect((r.draft as any).verdict.text).toBe('Se você pesa mais de 110 kg, evite nylon, segundo a ergocadeiras. Confira a base.');
    expect(b[0].text).toBe('A Classe 4 suporta 150 kg, segundo a ergocadeiras.');
    expect(b[1].text).toBe('Segundo a ergocadeiras, a base de aço é mais firme.');
    expect(b[2].text).toBe('A norma exige ensaio de base.');
    expect(b[3].text).toBe('Compare as fichas das duas marcas, segundo a ergocadeiras e a Flexform.');
    expect(b[5].caption).toBe('Peso suportado (segundo a ergocadeiras)');
    expect(r.refs).toEqual(['verdict', 's#0', 's#3', 's#5']);
  });
});

describe('resposta curta a partir das regras', () => {
  it('usa as 2 primeiras regras com evidências existentes', async () => {
    const { verdictFromRules } = await import('../src/stages/page.ts');
    const claims = new Map([['clm_a', {}], ['clm_b', {}]]);
    const v = verdictFromRules([
      'Regra de decisão sustentada: Se você pesa mais de 100 kg, escolha D45 ou mais (evidências: clm_a)',
      'outra nota',
      'Regra de decisão sustentada: Se você divide a cama, escolha molas ensacadas. (evidências: clm_b, clm_zz)',
      'Regra de decisão sustentada: Terceira regra que não entra (evidências: clm_a)',
    ], claims);
    expect(v).toEqual({ text: 'Se você pesa mais de 100 kg, escolha D45 ou mais. Se você divide a cama, escolha molas ensacadas.', claim_ids: ['clm_a', 'clm_b'] });
    expect(verdictFromRules(['Regra de decisão sustentada: sem evidência válida aqui (evidências: clm_x)'], claims)).toBeNull();
  });
});

describe('atribuição genérica vira com nomes', () => {
  it('não duplica "segundo"', async () => {
    const { attributeSingleSource } = await import('../src/stages/structure.ts');
    const src: Record<string, { publisher: string; source_class: string }> = { a: { publisher: 'Castor', source_class: 'manufacturer' }, b: { publisher: 'Ortobom', source_class: 'manufacturer' }, c: { publisher: 'Probel', source_class: 'manufacturer' } };
    const d = { title: 't', description: 'd', verdict: { text: 'A escolha considera o peso, segundo os fabricantes citados. Confira a ficha.', basis: 'evidence', claim_ids: ['a', 'b', 'c'] }, sections: [] } as never;
    expect((attributeSingleSource(d, (id) => src[id]).draft as any).verdict.text).toBe('A escolha considera o peso, segundo fabricantes como Castor, Ortobom e Probel. Confira a ficha.');
  });
});

describe('tirar bloco por pedido do editor', () => {
  it('tira bloco e tabela, apaga seção vazia, mas nunca esvazia o "Como decidir" nem deixa menos de 3 seções', async () => {
    const { applyRemovals } = await import('../src/stages/structure.ts');
    const p = (t: string) => ({ kind: 'paragraph' as const, text: t, basis: 'evidence' as const, claim_ids: ['c'] });
    const d = { title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] }, sections: [
      { id: 'a', heading: 'A', blocks: [p('a0')] },
      { id: 'garantia', heading: 'Garantia', blocks: [p('g0')] },
      { id: 'incluso', heading: 'O que vem incluso', blocks: [p('i0')] },
      { id: 'b', heading: 'B', blocks: [p('b0'), p('b1')] },
      { id: 'como-decidir', heading: 'Como decidir', blocks: [p('d0')] },
    ] } as never;
    const r = applyRemovals(d, ['garantia#0', 'incluso#0', 'b#1']);
    expect(r.done.sort()).toEqual(['b#1', 'garantia#0', 'incluso#0']);
    expect((r.draft as { sections: { id: string }[] }).sections.map((x) => x.id)).toEqual(['a', 'b', 'como-decidir']);
    const r2 = applyRemovals(r.draft, ['como-decidir#0', 'a#0']);
    expect(r2.done).toEqual([]);
    expect(r2.refused.join(' ')).toMatch(/Como decidir/);
    expect(r2.refused.join(' ')).toMatch(/menos de 3 seções/);
  });
});

describe('tirar coluna de tabela', () => {
  it('tira a coluna pelo nome, nunca a dos rótulos nem deixa a tabela com uma coluna só', async () => {
    const { dropTableColumns } = await import('../src/stages/structure.ts');
    const cell = (text: string) => ({ text, claim_ids: ['c'] });
    const d = { title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['c'] }, sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'table', caption: 'Medidas', columns: ['Tamanho', 'Largura × Comprimento', 'Para quem serve'], rows: [{ cells: [cell('Solteiro'), cell('88 × 188'), cell('Quem busca essa medida')] }, { cells: [cell('Viúva'), cell('128 × 188'), cell('Casais')] }] }] }] } as never;
    const r = dropTableColumns(d, [{ ref: 'como-decidir#0', column: 'para quem serve' }]);
    const t = (r.draft as any).sections[0].blocks[0];
    expect(t.columns).toEqual(['Tamanho', 'Largura × Comprimento']);
    expect(t.rows[0].cells.map((c: { text: string }) => c.text)).toEqual(['Solteiro', '88 × 188']);
    const r2 = dropTableColumns(r.draft, [{ ref: 'como-decidir#0', column: 'Largura × Comprimento' }, { ref: 'como-decidir#0', column: 'Tamanho' }]);
    expect(r2.done).toEqual([]);
    expect(r2.refused.join(' ')).toMatch(/uma coluna só/);
    expect(r2.refused.join(' ')).toMatch(/rótulos/);
  });
});

// 29/10: a maior causa isolada de não convergência da semana foi MISATTRIBUTED na decisão e na resposta curta,
// e o auditor dizia a causa com todas as letras (27/10, colchão firme ou macio): "os trechos citados são todos
// da Castor, mas o bloco apresenta como fatos gerais as faixas de densidade por peso; apenas a definição
// inicial é explicitamente atribuída". Bastava o nome aparecer uma vez para o resto do bloco passar sem fonte.
describe('atribuição frase a frase, não só na primeira', () => {
  const src: Record<string, { publisher: string; source_class: string }> = { a: { publisher: 'Castor', source_class: 'manufacturer' } };
  const bloco = async (text: string) => {
    const { attributeSingleSource } = await import('../src/stages/structure.ts');
    const d = { title: 't', description: 'd', verdict: { text: 'x.', basis: 'framing', claim_ids: [] }, sections: [{ id: 's', heading: 'S', blocks: [{ kind: 'paragraph', text, basis: 'evidence', claim_ids: ['a'] }] }] } as never;
    return (attributeSingleSource(d, (id) => src[id]).draft as any).sections[0].blocks[0].text as string;
  };

  it('a frase seguinte que traz número declarado também ganha fonte, com outro conector', async () => {
    const t = await bloco('Segundo a Castor, a densidade indica firmeza. A faixa recomendada para quem pesa até 60 kg é D20.');
    expect(t).toBe('Segundo a Castor, a densidade indica firmeza. A faixa recomendada para quem pesa até 60 kg é D20, segundo a Castor.');
  });

  it('para no teto de duas e não vira ladainha', async () => {
    const t = await bloco('A densidade é D20. A altura é 20 cm. A largura é 138 cm. A garantia é de 5 anos.');
    expect((t.match(/(segundo|conforme) a Castor/g) ?? []).length).toBe(2);
    expect(t).toContain('conforme a Castor'); // a segunda muda de conector
  });

  // Sem estes filtros a segunda atribuição caía em orientação ao leitor e em exemplo: medido em 65% dos blocos
  // tocados, inclusive de páginas que já estavam aprovadas.
  it('orientação ao leitor, exemplo e frase que já cita o fabricante não ganham fonte', async () => {
    for (const depois of ['Confira na etiqueta se o modelo tem 40 cm.', 'Exemplos: alguns modelos têm 40 cm.', 'O fabricante pode indicar 40 cm na ficha.']) {
      const t = await bloco(`Segundo a Castor, a densidade indica firmeza. ${depois}`);
      expect(t, depois).toBe(`Segundo a Castor, a densidade indica firmeza. ${depois}`);
    }
  });
});
