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
