import { describe, expect, it } from 'vitest';
import { checkClaim, checkPage, checkProduct, PageSpec, quoteAppearsIn, type Claim, type EvidenceIndex, type Source } from '../src/index.ts';

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
  question_ids: [],
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

describe('checkProduct', () => {
  const avail: Claim = {
    id: 'clm_disp', source_id: 'src_bbbbbbbbbbbb', quote: 'Colchão modelo X.', claim_type: 'availability',
    statement: 'Produto à venda na data.', captured_at: new Date().toISOString(), question_ids: [],
  };
  const retailIdx = (claims: Claim[]): EvidenceIndex => ({
    ...index(claims),
    sources: new Map([SRC, { ...RETAIL, final_url: 'https://www.amazon.com.br/dp/B000000001' }].map((s) => [s.id, s])),
  });
  const prod = { asin: 'B000000001', label: 'Modelo X casal', brand: 'Fabricante', kind: 'espuma' as const, evidence: 'manufacturer' as const, spec_claim_ids: ['clm_x_densidade'], availability_claim_id: 'clm_disp', added_at: '2026-10-20' };

  it('produto com ficha do fabricante e anúncio do mesmo ASIN passa', () => {
    expect(checkProduct(prod, retailIdx([claim(), avail]))).toEqual([]);
  });
  it('nome promocional e anúncio de outro ASIN são barrados', () => {
    const codes = checkProduct({ ...prod, label: 'O melhor colchão', asin: 'B000000009' }, retailIdx([claim(), avail])).map((v) => v.code);
    expect(codes).toContain('PRODUCT_PROMO_LABEL');
    expect(codes).toContain('PRODUCT_AVAILABILITY_OTHER_ASIN');
  });
  it('disponibilidade velha precisa de nova captura', () => {
    const old = { ...avail, captured_at: '2026-01-01T00:00:00.000Z' };
    expect(checkProduct(prod, retailIdx([claim(), old]), new Date('2026-10-20')).map((v) => v.code)).toContain('PRODUCT_AVAILABILITY_STALE');
  });
});

describe('checkProduct nível listing', () => {
  const quote = (q: string): Claim => ({ id: 'clm_anuncio', source_id: 'src_bbbbbbbbbbbb', quote: q, claim_type: 'availability', statement: 'Anúncio na data.', captured_at: new Date().toISOString(), question_ids: [] });
  const idxWith = (c: Claim): EvidenceIndex => ({
    ...index([c]),
    sources: new Map([SRC, { ...RETAIL, final_url: 'https://www.amazon.com.br/dp/B000000002' }].map((s) => [s.id, s])),
  });
  const p = { asin: 'B000000002', label: 'Marca Modelo', brand: 'Marca', kind: 'molas_ensacadas', evidence: 'listing' as const, spec_claim_ids: [], availability_claim_id: 'clm_anuncio', added_at: '2026-10-20' };
  it('aceita quando o anúncio diz literalmente o tipo', () => {
    expect(checkProduct(p, idxWith(quote('Colchão Casal Marca Modelo Molas Ensacadas 138x188')), new Date(), 'Colchão de molas ensacadas')).toEqual([]);
  });
  it('recusa quando o anúncio não diz o tipo', () => {
    expect(checkProduct(p, idxWith(quote('Colchão Casal Marca Modelo Espuma D33 138x188')), new Date(), 'Colchão de molas ensacadas').map((v) => v.code)).toContain('PRODUCT_KIND_NOT_IN_LISTING');
  });
  it('nível listing não pode carregar especificação', () => {
    expect(checkProduct({ ...p, spec_claim_ids: ['clm_x'] }, idxWith(quote('Colchão Molas Ensacadas Marca Modelo')), new Date(), 'Colchão de molas ensacadas').map((v) => v.code)).toContain('PRODUCT_LISTING_WITH_SPECS');
  });
});

describe('checkProduct: trecho de anúncio', () => {
  const mk = (q: string): EvidenceIndex => ({
    ...index([{ id: 'clm_anuncio', source_id: 'src_bbbbbbbbbbbb', quote: q, claim_type: 'availability', statement: 'Anúncio na data.', captured_at: new Date().toISOString(), question_ids: [] }]),
    sources: new Map([SRC, { ...RETAIL, final_url: 'https://www.amazon.com.br/dp/B000000003' }].map((s) => [s.id, s])),
  });
  const p = { asin: 'B000000003', label: 'Herval Alba', brand: 'Herval', kind: 'molas_ensacadas', evidence: 'listing' as const, spec_claim_ids: [], availability_claim_id: 'clm_anuncio', added_at: '2026-10-20' };
  const codes = (q: string) => checkProduct(p, mk(q), new Date(), 'Colchão de molas ensacadas', ['coluna']).map((v) => v.code);
  it('modelo do rótulo precisa estar no anúncio', () => expect(codes('Colchão de Molas Ensacadas Casal Herval Lucca')).toContain('PRODUCT_LABEL_NOT_IN_LISTING'));
  it('linha de imagem/link é recusada', () => expect(codes('![Colchão Molas Ensacadas Herval Alba](https://m.media-amazon.com/x.jpg)')).toContain('PRODUCT_LISTING_QUOTE_HAS_LINK'));
  it('termo proibido do nicho é recusado', () => expect(codes('Colchão Molas Ensacadas Herval Alba, Suporte para Coluna')).toContain('PRODUCT_LISTING_FORBIDDEN_TERM'));
  it('trecho limpo passa', () => expect(codes('Colchão de Molas Ensacadas Casal Herval Alba 138x188')).toEqual([]));
});

describe('firstForbidden', () => {
  it('termo curto só como palavra inteira', async () => {
    const { firstForbidden } = await import('../src/index.ts');
    expect(firstForbidden('Vendedor oficial, edredom incluso', ['dor'])).toBeNull();
    expect(firstForbidden('Alivia a dor nas costas', ['dor'])?.term).toBe('dor');
    expect(firstForbidden('Suporte Ortopédico', ['ortopéd'])?.term).toBe('ortopéd');
  });
});
