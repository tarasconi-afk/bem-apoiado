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
