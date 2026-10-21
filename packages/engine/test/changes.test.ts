import { describe, expect, it } from 'vitest';
import { describeChanges, exclusionOps, plainOutcome, type Read } from '../src/changes.ts';

const page = (status: string, verdict: string) => ({
  slug: 'como-escolher-travesseiro', page_type: 'buying_guide', status, title: 'Como escolher travesseiro: guia', description: 'd'.repeat(60),
  primary_query: 'como escolher travesseiro', updated_at: '2026-10-21', verdict: { text: verdict, basis: 'framing', claim_ids: [] },
  sections: [{ id: 's', heading: 'Seção', blocks: [{ kind: 'paragraph', text: 'texto igual', basis: 'framing', claim_ids: [] }] }],
  provenance: { run_id: 'r', writer_model: 'w', auditor_model: null, audit_verdict: 'pass' },
});
const product = { asin: 'B0F498TN8Z', label: 'D33 Miami', brand: 'D33', kind: 'espuma', evidence: 'listing', spec_claim_ids: [], availability_claim_id: 'clm_b7ad316e92dd', added_at: '2026-10-21' };
const main: Record<string, string> = { 'data/pages/como-escolher-travesseiro.json': JSON.stringify(page('approved', 'resposta curta antiga aqui')) };
const branch: Record<string, string> = {
  'data/pages/como-escolher-travesseiro.json': JSON.stringify(page('approved', 'resposta curta nova e corrigida')),
  'data/pages/como-escolher-cadeira.json': JSON.stringify({ ...page('draft', 'rascunho qualquer texto'), slug: 'como-escolher-cadeira', title: 'Como escolher cadeira de escritório' }),
  'data/products/B0F498TN8Z.json': JSON.stringify(product),
};
const rm: Read = (p) => main[p] ?? null;
const rb: Read = (p) => branch[p] ?? null;
const files = [
  { status: 'M' as const, path: 'data/pages/como-escolher-travesseiro.json' },
  { status: 'A' as const, path: 'data/pages/como-escolher-cadeira.json' },
  { status: 'A' as const, path: 'data/products/B0F498TN8Z.json' },
  { status: 'A' as const, path: 'data/sources/src_0a28fb5ef514/meta.json' },
  { status: 'A' as const, path: 'data/claims/clm_b7ad316e92dd.json' },
  { status: 'A' as const, path: 'data/runs/20261021T160034_autopilot_fd79/research.json' },
];

describe('mudanças de um resultado do motor', () => {
  it('separa o que o leitor vê (item a decidir) do aprendizado', () => {
    const s = describeChanges(files, rm, rb);
    expect(s.items.map((i) => i.id)).toEqual(['page:como-escolher-travesseiro', 'product:B0F498TN8Z']);
    expect(s.items[0]!.diffs).toEqual([{ where: 'Resposta curta', before: 'resposta curta antiga aqui', after: 'resposta curta nova e corrigida' }]);
    expect(s.items[1]!.title).toBe('Novo exemplo à venda: D33 Miami');
    expect(s.learning.join(' | ')).toContain('rascunho de "Como escolher cadeira de escritório"');
    expect(s.learning.join(' | ')).toContain('1 fonte(s) nova(s)');
  });

  it('capa da página nova vai no item da própria página', () => {
    const nb: Read = (p) => (p === 'data/pages/como-escolher-cadeira.json' ? JSON.stringify({ ...page('approved', 'resposta curta da cadeira nova'), slug: 'como-escolher-cadeira' }) : null);
    const s = describeChanges([
      { status: 'A', path: 'data/pages/como-escolher-cadeira.json' },
      { status: 'A', path: 'site/src/assets/generated/pagina-como-escolher-cadeira.webp' },
      { status: 'M', path: 'data/images/registry.json' },
    ], () => null, nb);
    expect(s.items.map((i) => i.id)).toEqual(['page:como-escolher-cadeira']);
    expect(s.items[0]!.paths).toHaveLength(3);
    expect(s.items[0]!.detail).toMatch(/capa/);
  });

  it('só aprendizado: nenhum item', () => {
    expect(describeChanges(files.slice(1).filter((f) => !f.path.includes('products')), rm, rb).items).toEqual([]);
  });

  it('item recusado volta à versão do main; produto recusado vai para retirados', () => {
    const s = describeChanges(files, rm, rb);
    const ops = exclusionOps(s, ['product:B0F498TN8Z'], rm, rb);
    expect(ops[0]).toEqual({ path: 'data/products/B0F498TN8Z.json', content: null });
    expect(ops[1]!.path).toBe('data/products-retired/B0F498TN8Z.json');
    expect(JSON.parse(ops[1]!.content!).reason).toMatch(/recusado pelo editor/);
  });

  it('motivo da parada em português', () => {
    expect(plainOutcome(['research: 0 evidências, 7 perguntas sem resposta', 'page: SAFE_STOP'])).toMatch(/não responderam/);
    expect(plainOutcome(['page: SAFE_STOP (AUDIT_NOT_CONVERGED)'])).toMatch(/3 voltas/);
    expect(plainOutcome(['page: NOT_PUBLISHABLE'])).toMatch(/rascunho/);
  });
});
