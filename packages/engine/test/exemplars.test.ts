import { describe, expect, it } from 'vitest';

describe('páginas modelo', () => {
  it('fixada primeiro, depois mesmo tipo; rascunho e a própria pauta ficam de fora', async () => {
    const { approvedExamples, exampleText } = await import('../src/exemplars.ts');
    const pg = (slug: string, page_type: string, status = 'approved') => ({
      slug, page_type, status, title: slug, verdict: { text: `Escolha pelo peso em ${slug}.`, basis: 'evidence', claim_ids: [] },
      sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'table', caption: 'Faixas', columns: ['Peso', 'Densidade'], rows: [{ cells: [{ text: 'Até 60 kg', claim_ids: [] }, { text: 'D26', claim_ids: [] }] }] }] }],
    });
    // colchao-firme-ou-macio é a fixada em data/model-pages.json; as outras só entram com veredito de aprovação real
    const pages = [pg('outra', 'buying_guide'), pg('colchao-firme-ou-macio', 'decision_compare'), pg('rascunho', 'decision_compare', 'draft')];
    const out = approvedExamples({ pageType: 'buying_guide', exclude: 'nova', max: 3 }, pages as never).map((p) => p.slug);
    expect(out[0]).toBe('colchao-firme-ou-macio');
    expect(out).not.toContain('rascunho');
    expect(approvedExamples({ exclude: 'colchao-firme-ou-macio' }, pages as never).map((p) => p.slug)).not.toContain('colchao-firme-ou-macio');
    expect(exampleText(pages[1] as never)).toContain('[tabela: Faixas] Peso | Densidade\nAté 60 kg | D26');
  });
});
