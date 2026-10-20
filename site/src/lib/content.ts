import { referencedClaimIds, type Claim, type PageSpec, type Source } from '@bem-apoiado/core';
import { loadClaims, loadPages, loadSources } from '@bem-apoiado/engine';

// Indexação só é liberada com SITE_INDEXABLE=true explícito no ambiente de deploy.
export const INDEXABLE = process.env.SITE_INDEXABLE === 'true';

export const BRAND = 'Bem Apoiado';

// Só páginas aprovadas e auditadas vão ao ar. Rascunhos aparecem apenas com SITE_SHOW_DRAFTS=true (preview).
export function publicPages(): PageSpec[] {
  const showDrafts = process.env.SITE_SHOW_DRAFTS === 'true';
  return loadPages().filter((p) => p.status !== 'draft' || showDrafts);
}

// Fontes agrupadas por documento: o número da citação aponta para a fonte, e cada fonte lista
// os trechos literais que a página usou dela.
export interface SourceNote {
  n: number;
  source: Source;
  claims: Claim[];
}

export interface Footnotes {
  notes: SourceNote[];
  numberFor: (claimIds: string[]) => number[];
}

export function footnotesFor(page: PageSpec): Footnotes {
  const claims = new Map(loadClaims().map((c) => [c.id, c]));
  const sources = new Map(loadSources().map((s) => [s.id, s]));
  const bySource = new Map<string, SourceNote>();
  for (const id of referencedClaimIds(page)) {
    const c = claims.get(id);
    const s = c ? sources.get(c.source_id) : undefined;
    if (!c || !s) continue;
    if (!bySource.has(s.id)) bySource.set(s.id, { n: bySource.size + 1, source: s, claims: [] });
    bySource.get(s.id)!.claims.push(c);
  }
  return {
    notes: [...bySource.values()],
    numberFor: (ids) =>
      [...new Set(ids.map((id) => bySource.get(claims.get(id)?.source_id ?? '')?.n).filter((n): n is number => !!n))].sort(
        (a, b) => a - b,
      ),
  };
}

export function readingMinutes(page: PageSpec): number {
  let words = page.verdict.text.split(/\s+/).length;
  for (const s of page.sections)
    for (const b of s.blocks)
      words += b.kind === 'table' ? b.rows.flatMap((r) => r.cells.map((c) => c.text)).join(' ').split(/\s+/).length / 2 : b.text.split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
