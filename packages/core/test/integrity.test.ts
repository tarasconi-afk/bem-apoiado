import { describe, expect, it } from 'vitest';
import { checkClaim, checkPage, PageSpec, quoteAppearsIn, type Claim, type EvidenceIndex, type Source } from '../src/index.ts';

// Fixtures sintéticas de teste. Não são conteúdo editorial e nunca vão para data/.
const SRC: Source = {
  id: 'src_aaaaaaaaaaaa',
  url: 'https://exemplo.test/ficha',
  final_url: 'https://exemplo.test/ficha',
  fetched_at: '2026-10-20T12:00:00.000Z',
  http_status: 200,
  content_type: 'text/html',
  sha256: 'a'.repeat(64),
  raw_file: 'raw.html',
  text_file: 'text.txt',
  text_chars: 100,
  extractor_version: 2,
  title: 'Ficha',
  publisher: 'Fabricante Teste',
  source_class: 'manufacturer',
};
const RETAIL: Source = { ...SRC, id: 'src_bbbbbbbbbbbb', source_class: 'retailer_listing' };
const TEXT = 'Colchão modelo X.\nDensidade   da espuma: D33 – indicada até 100 kg.\nGarantia de 1 ano.';

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'clm_x_densidade',
  source_id: SRC.id,
  quote: 'Densidade da espuma: D33 - indicada até 100 kg',
  claim_type: 'spec',
  statement: 'O modelo X usa espuma D33 indicada até 100 kg.',
  captured_at: '2026-10-20T12:00:00.000Z',
  ...over,
});

const index = (claims: Claim[]): EvidenceIndex => ({
  claims: new Map(claims.map((c) => [c.id, c])),
  sources: new Map([SRC, RETAIL].map((s) => [s.id, s])),
  sourceText: (id) => (id === SRC.id || id === RETAIL.id ? TEXT : undefined),
});

describe('quoteAppearsIn', () => {
  it('tolera espaços e travessão tipográfico', () => {
    expect(quoteAppearsIn('densidade da espuma: D33 - indicada', TEXT)).toBe(true);
  });
  it('não tolera número diferente', () => {
    expect(quoteAppearsIn('Densidade da espuma: D28', TEXT)).toBe(false);
  });
});

describe('checkClaim', () => {
  it('aceita citação literal de fonte primária', () => {
    const c = claim();
    expect(checkClaim(c, index([c]))).toEqual([]);
  });
  it('rejeita citação que não está na fonte', () => {
    const c = claim({ quote: 'Densidade da espuma: D45 indicada até 150 kg' });
    expect(checkClaim(c, index([c])).map((v) => v.code)).toContain('QUOTE_NOT_IN_SOURCE');
  });
  it('rejeita especificação vinda de anúncio de loja', () => {
    const c = claim({ source_id: RETAIL.id });
    expect(checkClaim(c, index([c])).map((v) => v.code)).toContain('CLAIM_SOURCE_CLASS_NOT_ALLOWED');
  });
});

const basePage = (): PageSpec =>
  PageSpec.parse({
    slug: 'colchao-teste',
    page_type: 'decision_compare',
    status: 'draft',
    title: 'Colchão teste: qual escolher',
    description: 'Página sintética usada apenas nos testes automatizados do validador de integridade.',
    primary_query: 'colchão teste',
    updated_at: '2026-10-20',
    verdict: { text: 'O modelo X atende quem pesa até 100 kg.', basis: 'reasoning', claim_ids: ['clm_x_densidade'] },
    sections: [
      {
        id: 'contexto',
        heading: 'Contexto',
        blocks: [{ kind: 'paragraph', text: 'Qual densidade faz sentido para você?', basis: 'framing', claim_ids: [] }],
      },
    ],
    provenance: { run_id: 'test', writer_model: 'test', auditor_model: null, audit_verdict: 'pending' },
  });

describe('checkPage', () => {
  it('página coerente passa', () => {
    expect(checkPage(basePage(), index([claim()]))).toEqual([]);
  });
  it('framing com número é bloqueado', () => {
    const p = basePage();
    p.sections[0]!.blocks[0] = { kind: 'paragraph', text: 'Aguenta 100 kg.', basis: 'framing', claim_ids: [] };
    expect(checkPage(p, index([claim()])).map((v) => v.code)).toContain('FRAMING_HAS_NUMBER');
  });
  it('referência a evidência inexistente é bloqueada', () => {
    const p = basePage();
    p.verdict.claim_ids = ['clm_inventada'];
    expect(checkPage(p, index([claim()])).map((v) => v.code)).toContain('CLAIM_REF_UNKNOWN');
  });
  it('número em tabela sem evidência é bloqueado', () => {
    const p = basePage();
    p.sections[0]!.blocks.push({
      kind: 'table',
      caption: 'Comparação',
      columns: ['Item', 'Valor'],
      rows: [{ cells: [{ text: 'Carga', claim_ids: [] }, { text: '100 kg', claim_ids: [] }] }],
    });
    expect(checkPage(p, index([claim()])).map((v) => v.code)).toContain('TABLE_NUMBER_UNCITED');
  });
  it('página não auditada não pode sair de draft', () => {
    const p = basePage();
    p.status = 'approved';
    expect(checkPage(p, index([claim()])).map((v) => v.code)).toContain('UNAUDITED_NOT_DRAFT');
  });
});
