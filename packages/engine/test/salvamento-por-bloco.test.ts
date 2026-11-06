import { describe, expect, it } from 'vitest';
import { applyPatches } from '../src/stages/patch.ts';
import { salvageBlocks } from '../src/stages/page.ts';

// 05/11, lençol de cetim ou percal: 8 linhas de uma tabela recusadas pela legenda contavam como 8 blocos e
// passavam do limite de salvamento; a página inteira foi descartada.
describe('salvamento conta blocos, não linhas', () => {
  const linhas = Array.from({ length: 8 }, (_, i) => ({ ref: `medidas-declaradas#0.r${i}` }));

  it('8 linhas da mesma tabela são 1 bloco', () => {
    expect(salvageBlocks(linhas)).toBe(1);
    expect(salvageBlocks([...linhas, { ref: 'tipos#1' }, { ref: 'tipos#2' }])).toBe(3);
    expect(salvageBlocks([{ ref: 'a#0' }, { ref: 'b#0' }, { ref: 'c#0' }, { ref: 'd#0.r1' }])).toBe(4);
  });

  it('remover todas as linhas apaga a tabela e mantém o resto da seção', () => {
    const cell = (text: string) => ({ text, claim_ids: ['clm_x'] });
    const draft = {
      title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['clm_x'] },
      sections: [{ id: 'medidas-declaradas', heading: 'Medidas', blocks: [
        { kind: 'table', caption: 'c', columns: ['Tamanho', 'Medida'], rows: Array.from({ length: 8 }, () => ({ cells: [cell('a'), cell('b')] })) },
        { kind: 'paragraph', text: 'Confira a medida no anúncio.', basis: 'evidence', claim_ids: ['clm_x'] },
      ] }],
    };
    const d = applyPatches(draft as never, linhas.map((l) => ({ ref: l.ref, action: 'remove' as const })));
    expect(d.sections[0]!.blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });
});

describe('tabela com problema na legenda ou no travessão (05/11, cetim ou percal)', () => {
  const cell = (text: string) => ({ text, claim_ids: ['clm_aaaaaaaaaaaa'] });
  const tabela = () => ({
    title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['clm_aaaaaaaaaaaa'] },
    sections: [{ id: 'medidas', heading: 'Medidas', blocks: [
      { kind: 'table', caption: 'Medidas em lençóis de percal e cetim', columns: ['Tamanho', 'Cetim (Corttex 300 fios)'], rows: [
        { cells: [cell('Solteiro — Lençol'), cell('1,60 m × 2,50 m')] },
        { cells: [cell('Casal, lençol'), cell('—')] },
        { cells: [cell('Queen, lençol'), cell('2,40 m × 2,60 m')] },
      ] },
    ] }],
  });

  it('o travessão sai das células sem IA; célula só com travessão vira "sem dado"', async () => {
    const { fixFormWithoutAI, styleIssues } = await import('../src/stages/page.ts');
    const r = fixFormWithoutAI(tabela() as never);
    const rows = (r.draft.sections[0]!.blocks[0] as any).rows;
    expect(rows[0].cells[0].text).toBe('Solteiro, Lençol');
    // a linha sem dado (só travessão) virou "Não informado" e a regra que já existia a tirou da tabela
    expect(rows.map((x: any) => x.cells[0].text)).toEqual(['Solteiro, Lençol', 'Queen, lençol']);
    expect(JSON.stringify(r.draft)).not.toContain('—');
    expect(r.refs).toContain('medidas#0.r0');
    expect(styleIssues(r.draft).filter((i) => /travessão/.test(i.msg))).toEqual([]);
  });

  it('travessão na legenda é consertado e todas as linhas voltam para conferência', async () => {
    const { fixFormWithoutAI } = await import('../src/stages/page.ts');
    const d = tabela();
    (d.sections[0]!.blocks[0] as any).caption = 'Medidas — Corttex';
    const r = fixFormWithoutAI(d as never);
    expect((r.draft.sections[0]!.blocks[0] as any).caption).toBe('Medidas, Corttex');
    expect(r.refs).toEqual(expect.arrayContaining(['medidas#0.r0', 'medidas#0.r1', 'medidas#0.r2']));
  });

  it('o remendo de linha alcança a legenda e os nomes das colunas', () => {
    const d = applyPatches(tabela() as never, [{
      ref: 'medidas#0.r0', action: 'replace', cells: [cell('Solteiro, lençol'), cell('1,60 m × 2,50 m')],
      caption: 'Medidas declaradas pela Corttex (lençol de cetim, 300 fios)', columns: ['Tamanho', 'Medida'],
    }] as never);
    const b = d.sections[0]!.blocks[0] as any;
    expect(b.caption).toBe('Medidas declaradas pela Corttex (lençol de cetim, 300 fios)');
    expect(b.columns).toEqual(['Tamanho', 'Medida']);
    expect(b.rows[0].cells[0].text).toBe('Solteiro, lençol');
  });

  it('o remendo não pode mudar o número de colunas', async () => {
    const { makePatchSchema } = await import('../src/stages/patch.ts');
    const s = makePatchSchema(['medidas#0.r0'], ['clm_aaaaaaaaaaaa'], new Map([['medidas#0.r0', ['Tamanho', 'Cetim']]]));
    const base = { ref: 'medidas#0.r0', action: 'replace', cells: [cell('a'), cell('b')] };
    expect(s.safeParse({ patches: [{ ...base, columns: ['Tamanho', 'Medida'] }] }).success).toBe(true);
    expect(s.safeParse({ patches: [{ ...base, columns: ['Tamanho', 'Medida', 'Extra'] }] }).success).toBe(false);
  });
});

describe('gate aponta a tabela inteira (06/11, como escolher lençol)', () => {
  const cell = (text: string) => ({ text, claim_ids: ['clm_aaaaaaaaaaaa'] });
  const draft = {
    title: 't', description: 'd', verdict: { text: 'v', basis: 'evidence', claim_ids: ['clm_aaaaaaaaaaaa'] },
    sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [
      { kind: 'table', caption: 'Tamanho de cama e medida de lençol', columns: ['Tamanho de cama', 'Medida padrão da cama'], rows: [{ cells: [cell('Solteiro'), cell('0,88 m × 1,88 m')] }] },
    ] }],
  };

  it('o remendo da tabela inteira troca a coluna sem mexer nas linhas', async () => {
    const { makePatchSchema, tableColumns } = await import('../src/stages/patch.ts');
    const cols = tableColumns(draft as never, ['como-decidir#0']);
    expect(cols.get('como-decidir#0')).toEqual(['Tamanho de cama', 'Medida padrão da cama']);
    const s = makePatchSchema(['como-decidir#0'], ['clm_aaaaaaaaaaaa'], cols);
    const patch = { ref: 'como-decidir#0', action: 'replace', columns: ['Tamanho de cama', 'Medida declarada nos modelos citados'] };
    expect(s.safeParse({ patches: [patch] }).success).toBe(true); // sem "cells"
    const d = applyPatches(draft as never, [patch] as never);
    const b = d.sections[0]!.blocks[0] as any;
    expect(b.columns[1]).toBe('Medida declarada nos modelos citados');
    expect(b.rows[0].cells[1].text).toBe('0,88 m × 1,88 m');
  });
});
