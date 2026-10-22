import { describe, expect, it } from 'vitest';
import { styleIssues } from '../src/stages/page.ts';
import { selectClaims } from '../src/stages/draft-schema.ts';

const draft = (verdict: string, decide = 'Se você divide a cama, prefira molas ensacadas.') => ({
  title: 'Colchão de molas ou espuma: como decidir', description: 'd'.repeat(60),
  verdict: { text: verdict, basis: 'reasoning' as const, claim_ids: [] },
  sections: [
    { id: 'a', heading: 'Tipos', blocks: [{ kind: 'paragraph' as const, text: 'Texto do bloco com frase completa aqui.', basis: 'claim' as const, claim_ids: [] }] },
    { id: 'b', heading: 'Diferenças', blocks: [{ kind: 'paragraph' as const, text: 'Outro bloco com frase completa aqui.', basis: 'claim' as const, claim_ids: [] }] },
    { id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'paragraph' as const, text: decide, basis: 'reasoning' as const, claim_ids: [] }] },
  ],
});
const msgs = (d: ReturnType<typeof draft>) => styleIssues(d as never).map((i) => i.msg).join(' | ');

describe('resposta curta', () => {
  it('passa a resposta prática e curta', () => {
    expect(msgs(draft('Depende de quem divide a cama. Para casal, molas ensacadas reduzem a transferência de movimento.'))).toBe('');
  });
  it('recusa mais de 3 frases, abertura por norma e "trechos citados"', () => {
    expect(msgs(draft('Uma. Duas frases. Três frases aqui. Quatro frases.'))).toMatch(/4 frases/);
    expect(msgs(draft('O Inmetro exclui bases não acopladas do regulamento.'))).toMatch(/não pode abrir com norma/);
    expect(msgs(draft('Segundo Simmons e Castor, pessoas leves preferem macio.'))).toMatch(/citando uma marca/);
    expect(msgs(draft('Depende do uso.', 'Nos trechos citados, não há medida de comprimento.'))).toMatch(/trechos citados/);
  });
});

describe('evidências para o redator', () => {
  it('limita, mantém as citadas e prioriza as ligadas às perguntas', () => {
    const topic = { questions: [{ id: 'q1', text: 'x' }], source_ids: ['s1', 's2'], focus_terms: ['densidade'] } as never;
    const claims = Array.from({ length: 80 }, (_, i) => ({ id: `clm_${String(i).padStart(12, '0')}`, source_id: i % 2 ? 's1' : 's2', quote: i < 5 ? 'densidade' : 'outro', question_ids: i < 40 ? ['q1'] : ['q9'] })) as never[];
    const keep = new Set(['clm_000000000039']);
    const out = selectClaims(topic, claims, () => 'manufacturer', keep, 30);
    expect(out).toHaveLength(30);
    expect(out.map((c: { id: string }) => c.id)).toContain('clm_000000000039');
  });
});

describe('adotar a versão sustentada do auditor', () => {
  it('troca o texto do bloco reprovado pela proposta do auditor, mantendo as fontes; tira travessão', async () => {
    const { adoptAuditorFixes } = await import('../src/stages/page.ts');
    const d = draft('Depende do uso.', 'Se você divide a cama, prefira molas ensacadas sempre.');
    d.sections[2]!.blocks[0]!.claim_ids = ['clm_aaaaaaaaaaaa'] as never;
    const r = adoptAuditorFixes(d as never, [
      { ref: 'como-decidir#0', verdict: 'OVERSTATED', fix: 'Se você divide a cama, a Probel indica molas ensacadas — que reduzem movimento.' },
      { ref: 'a#0', verdict: 'SUPPORTED', fix: '' },
      { ref: 'b#0', verdict: 'UNSUPPORTED', fix: '' },
    ]);
    expect(r.refs).toEqual(['como-decidir#0']);
    const b = r.draft.sections[2]!.blocks[0] as { text: string; claim_ids: string[] };
    expect(b.text).toBe('Se você divide a cama, a Probel indica molas ensacadas, que reduzem movimento.');
    expect(b.claim_ids).toEqual(['clm_aaaaaaaaaaaa']);
  });
});

describe('conserto de forma sem IA', () => {
  it('leva a atribuição para o fim da primeira frase e tira travessão', async () => {
    const { fixFormWithoutAI, styleIssues: si } = await import('../src/stages/page.ts');
    const d = draft('Segundo a Ortobom, cadeiras gamer têm encosto alto e reclinável. Confira a regulagem — e o peso suportado.');
    const r = fixFormWithoutAI(d as never);
    expect(r.draft.verdict.text).toBe('Cadeiras gamer têm encosto alto e reclinável, segundo a Ortobom. Confira a regulagem, e o peso suportado.');
    expect(si(r.draft as never).filter((i) => i.ref === 'verdict')).toEqual([]);
  });
});
