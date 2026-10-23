import { EDITOR_PICK_MAX_AGE_DAYS, PRIMARY_CLASSES, type Claim, type PageSpec, type Product, type Source, type SourceClass } from './schemas.ts';
import { firstForbidden, normalizeForMatch, quoteAppearsIn } from './text.ts';

export interface Violation {
  code: string;
  where: string;
  detail: string;
}

export interface EvidenceIndex {
  claims: Map<string, Claim>;
  sources: Map<string, Source>;
  sourceText: (sourceId: string) => string | undefined;
}

// Que classe de fonte pode sustentar cada tipo de evidência. Anúncio de loja nunca prova especificação.
const ALLOWED_CLASSES: Record<Claim['claim_type'], readonly SourceClass[]> = {
  spec: [...PRIMARY_CLASSES, 'independent_test'],
  certification: ['manufacturer', 'regulator'],
  regulation: ['regulator', 'standard_body'],
  definition: [...PRIMARY_CLASSES, 'independent_test'],
  availability: ['retailer_listing', 'manufacturer'],
};

const HAS_NUMBER = /\d/;

export function checkClaim(claim: Claim, idx: EvidenceIndex): Violation[] {
  const out: Violation[] = [];
  const where = `claim:${claim.id}`;
  const src = idx.sources.get(claim.source_id);
  if (!src) return [{ code: 'CLAIM_SOURCE_MISSING', where, detail: claim.source_id }];
  if (!ALLOWED_CLASSES[claim.claim_type].includes(src.source_class)) {
    out.push({
      code: 'CLAIM_SOURCE_CLASS_NOT_ALLOWED',
      where,
      detail: `${claim.claim_type} não pode vir de ${src.source_class}`,
    });
  }
  const text = idx.sourceText(claim.source_id);
  if (text === undefined) {
    out.push({ code: 'SOURCE_TEXT_MISSING', where, detail: claim.source_id });
  } else if (!quoteAppearsIn(claim.quote, text)) {
    out.push({ code: 'QUOTE_NOT_IN_SOURCE', where, detail: claim.quote.slice(0, 120) });
  }
  return out;
}

export function checkPage(page: PageSpec, idx: EvidenceIndex): Violation[] {
  const out: Violation[] = [];
  const ref = (ids: string[], where: string) => {
    for (const id of ids) {
      if (!idx.claims.has(id)) out.push({ code: 'CLAIM_REF_UNKNOWN', where, detail: id });
    }
  };
  const basisRule = (basis: string, ids: string[], text: string, where: string) => {
    ref(ids, where);
    if ((basis === 'evidence' || basis === 'reasoning') && ids.length === 0) {
      out.push({ code: 'BASIS_REQUIRES_CLAIMS', where, detail: basis });
    }
    if (basis === 'framing') {
      if (ids.length > 0) out.push({ code: 'FRAMING_CITES_CLAIMS', where, detail: ids.join(',') });
      if (HAS_NUMBER.test(text)) out.push({ code: 'FRAMING_HAS_NUMBER', where, detail: text.slice(0, 80) });
    }
  };

  basisRule(page.verdict.basis, page.verdict.claim_ids, page.verdict.text, 'verdict');
  for (const s of page.sections) {
    s.blocks.forEach((b, i) => {
      const where = `section:${s.id}#${i}`;
      if (b.kind === 'table') {
        b.rows.forEach((r, ri) => {
          if (r.cells.length !== b.columns.length) {
            out.push({ code: 'TABLE_SHAPE', where: `${where}.row${ri}`, detail: `${r.cells.length}/${b.columns.length}` });
          }
          r.cells.forEach((c, ci) => {
            ref(c.claim_ids, `${where}.r${ri}c${ci}`);
            // Primeira coluna é rótulo; demais células com número precisam de evidência.
            if (ci > 0 && HAS_NUMBER.test(c.text) && c.claim_ids.length === 0) {
              out.push({ code: 'TABLE_NUMBER_UNCITED', where: `${where}.r${ri}c${ci}`, detail: c.text });
            }
          });
        });
      } else {
        basisRule(b.basis, b.claim_ids, b.text, where);
      }
    });
  }
  page.products.forEach((p, i) => ref(p.claim_ids, `product#${i}`));

  if (page.status !== 'draft' && page.provenance.audit_verdict !== 'pass') {
    out.push({ code: 'UNAUDITED_NOT_DRAFT', where: 'status', detail: page.status });
  }
  return out;
}

const PROMO = /\b(melhor|top|imbatível|perfeito|campeão|número 1|nº 1|n°1|recomendado|oferta|promoção|barato|luxo|premium|super)\b/i;
// Disponibilidade mais velha que isso precisa de nova captura antes de exibir o produto.
export const AVAILABILITY_MAX_AGE_DAYS = 30;

export function checkProduct(p: Product, idx: EvidenceIndex, now = new Date(), kindLabel?: string, forbidden: string[] = []): Violation[] {
  const out: Violation[] = [];
  const where = `product:${p.asin}`;
  // "Pillow top" é nome do produto, não "top" de ranking (23/10: Herval Pillow Top Avulso recusado como promoção).
  if (PROMO.test(p.label.replace(/pillow[\s-]*top/gi, ''))) out.push({ code: 'PRODUCT_PROMO_LABEL', where, detail: p.label });
  if (p.evidence === 'editor') {
    const age = (now.getTime() - new Date(p.editor?.checked_at ?? 0).getTime()) / 86_400_000;
    if (age > EDITOR_PICK_MAX_AGE_DAYS) out.push({ code: 'PRODUCT_EDITOR_STALE', where, detail: `${Math.round(age)} dias sem conferência do editor` });
    if (p.spec_claim_ids.length) out.push({ code: 'PRODUCT_LISTING_WITH_SPECS', where, detail: 'escolha do editor não exibe especificação' });
    if (firstForbidden(p.label, forbidden)) out.push({ code: 'PRODUCT_LISTING_FORBIDDEN_TERM', where, detail: p.label });
    return out;
  }
  if (p.evidence === 'manufacturer' && p.spec_claim_ids.length === 0) out.push({ code: 'PRODUCT_SPEC_MISSING', where, detail: 'nível manufacturer sem especificação' });
  if (p.evidence === 'listing' && p.spec_claim_ids.length > 0) out.push({ code: 'PRODUCT_LISTING_WITH_SPECS', where, detail: 'nível listing não pode exibir especificação' });
  // Nível listing: o trecho do anúncio tem de conter literalmente as palavras do tipo (ex.: "molas ensacadas").
  if (p.evidence === 'listing' && kindLabel) {
    const quote = normalizeForMatch(idx.claims.get(p.availability_claim_id ?? '')?.quote ?? '').replace(/-/g, ' ');
    const words = normalizeForMatch(kindLabel).split(/\s+/).filter((w) => w.length >= 5);
    const miss = words.filter((w) => !quote.includes(w.slice(0, -1)));
    if (miss.length) out.push({ code: 'PRODUCT_KIND_NOT_IN_LISTING', where, detail: miss.join(',') });
  }
  if (p.evidence === 'listing') {
    const raw = idx.claims.get(p.availability_claim_id ?? '')?.quote ?? '';
    const q = normalizeForMatch(raw).replace(/-/g, ' ');
    if (/!\[|\]\(|https?:\/\//.test(raw)) out.push({ code: 'PRODUCT_LISTING_QUOTE_HAS_LINK', where, detail: raw.slice(0, 60) });
    const nameMiss = normalizeForMatch(p.label).replace(/-/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !q.includes(w));
    if (nameMiss.length) out.push({ code: 'PRODUCT_LABEL_NOT_IN_LISTING', where, detail: nameMiss.join(',') });
    const bad = firstForbidden(raw, forbidden);
    if (bad) out.push({ code: 'PRODUCT_LISTING_FORBIDDEN_TERM', where, detail: bad.term });
  }
  for (const id of p.spec_claim_ids) {
    const c = idx.claims.get(id);
    const src = c ? idx.sources.get(c.source_id) : undefined;
    if (!c) out.push({ code: 'PRODUCT_SPEC_MISSING', where, detail: id });
    else if (src?.source_class !== 'manufacturer' || !['spec', 'certification'].includes(c.claim_type)) {
      out.push({ code: 'PRODUCT_SPEC_NOT_FROM_MANUFACTURER', where, detail: id });
    }
  }
  const a = idx.claims.get(p.availability_claim_id ?? '');
  if (!a || a.claim_type !== 'availability') {
    out.push({ code: 'PRODUCT_AVAILABILITY_MISSING', where, detail: p.availability_claim_id ?? 'ausente' });
  } else {
    const ageDays = (now.getTime() - new Date(a.captured_at).getTime()) / 86_400_000;
    if (ageDays > AVAILABILITY_MAX_AGE_DAYS) out.push({ code: 'PRODUCT_AVAILABILITY_STALE', where, detail: `${Math.round(ageDays)} dias` });
    const src = idx.sources.get(a.source_id);
    if (src && !new RegExp(`/(dp|gp/product)/${p.asin}`).test(src.final_url)) {
      out.push({ code: 'PRODUCT_AVAILABILITY_OTHER_ASIN', where, detail: src.final_url });
    }
  }
  return out;
}

export function referencedClaimIds(page: PageSpec): string[] {
  const ids = new Set<string>(page.verdict.claim_ids);
  for (const s of page.sections) {
    for (const b of s.blocks) {
      if (b.kind === 'table') b.rows.forEach((r) => r.cells.forEach((c) => c.claim_ids.forEach((id) => ids.add(id))));
      else b.claim_ids.forEach((id) => ids.add(id));
    }
  }
  page.products.forEach((p) => p.claim_ids.forEach((id) => ids.add(id)));
  return [...ids];
}
