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

export interface Footnotes {
  order: string[];
  claims: Map<string, Claim>;
  sources: Map<string, Source>;
}

export function footnotesFor(page: PageSpec): Footnotes {
  const claims = new Map(loadClaims().map((c) => [c.id, c]));
  const sources = new Map(loadSources().map((s) => [s.id, s]));
  return { order: referencedClaimIds(page), claims, sources };
}
