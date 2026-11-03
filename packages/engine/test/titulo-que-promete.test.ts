import { describe, expect, it } from 'vitest';
import { renameFromCoherence } from '../src/stages/structure.ts';

// 03/11: "seção que não entrega" foi a causa nº 1 de reprovação de 29/10 a 03/11 (4 de 6 rascunhos). O juiz
// sempre pedia o mesmo conserto -- trocar o título da seção pelo que os blocos dizem -- e o motor não conseguia:
// os remendos só substituem ou removem bloco. Dois daqueles rascunhos o editor aprovou sem mudar nada.
const p = (text: string) => ({ kind: 'paragraph', text, basis: 'evidence', claim_ids: ['c'] });
const rascunho = () => ({
  title: 'Lençol de percal ou algodão', description: 'd',
  verdict: { text: 'Escolha pelo toque.', basis: 'evidence', claim_ids: ['c'] },
  sections: [
    { id: 'o-que-e-percal', heading: 'O que é percal e o que é algodão comum', blocks: [p('Percal é uma trama.')] },
    { id: 'medidas', heading: 'Medidas', blocks: [{ kind: 'table', caption: 'Espuma e fibra por posição', columns: ['a', 'b'], rows: [{ cells: [{ text: 'x', claim_ids: ['c'] }, { text: 'y', claim_ids: ['c'] }] }] }] },
    { id: 'como-decidir', heading: 'Como decidir', blocks: [p('Se você quer toque liso, escolha percal.')] },
  ],
}) as never;
const achado = (ref: string, fix: string, check = 'secao_nao_entrega') => ({ check, ref, problem: 'promete demais', fix });

describe('título que promete o que a seção não traz', () => {
  it('troca o título da seção pelo que o juiz sugeriu entre aspas', () => {
    const r = renameFromCoherence(rascunho(), [achado('o-que-e-percal#0', 'Mudar o título da seção para “O que os fabricantes dizem sobre o percal”.')]);
    expect((r.draft as any).sections[0].heading).toBe('O que os fabricantes dizem sobre o percal');
    expect(r.resolved).toEqual([0]);
  });

  it('quando o juiz fala de tabela, troca a legenda da tabela e não o título da seção', () => {
    const r = renameFromCoherence(rascunho(), [achado('medidas#0.r0', 'Mude o título da tabela para "Travesseiros de espuma por posição".')]);
    expect((r.draft as any).sections[1].blocks[0].caption).toBe('Travesseiros de espuma por posição');
    expect((r.draft as any).sections[1].heading).toBe('Medidas');
  });

  // O motor acha o "Como decidir" pelo título; renomeá-lo quebraria a estrutura da página.
  it('nunca renomeia o Como decidir', () => {
    const r = renameFromCoherence(rascunho(), [achado('como-decidir#0', 'Mudar o título para “Escolha pelo toque”.')]);
    expect((r.draft as any).sections[2].heading).toBe('Como decidir');
    expect(r.resolved).toEqual([]);
  });

  // Título não carrega fonte: um número no título seria afirmação sem evidência.
  it('recusa sugestão com número, sugestão sem aspas e outros tipos de achado', () => {
    const r = renameFromCoherence(rascunho(), [
      achado('o-que-e-percal#0', 'Mudar o título para “Percal de 200 fios”.'),
      achado('o-que-e-percal#0', 'Mudar o título para algo que corresponda ao conteúdo.'),
      achado('o-que-e-percal#0', 'Mudar o título para “Outro”.', 'promessa_do_titulo'),
    ]);
    expect((r.draft as any).sections[0].heading).toBe('O que é percal e o que é algodão comum');
    expect(r.resolved).toEqual([]);
  });
});
