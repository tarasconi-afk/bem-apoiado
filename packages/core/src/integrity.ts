import { PRIMARY_CLASSES, type Claim, type PageSpec, type Source, type SourceClass } from './schemas.ts';
import { quoteAppearsIn } from './text.ts';

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
