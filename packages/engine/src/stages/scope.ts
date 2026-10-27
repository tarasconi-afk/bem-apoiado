import { join } from 'node:path';
import type { z } from 'zod';
import { ClaimScope, type Claim, type Source } from '@bem-apoiado/core';
import { jevDecide, type ChoiceQuestion, type Decider } from '../jev.ts';
import { CLAIMS_DIR, loadClaims, loadSources, writeJson } from '../store.ts';

// Alcance das evidências anteriores a 27/10 (a extração passou a gravá-lo nesse dia). Sem ele, o redator e a
// seleção de evidências deduziam pelo tipo e pela classe da fonte, e o guia "Medidas de colchão" da Castor (que
// fala dos tamanhos em geral) era tratado como ficha de um produto. Classe de fonte decide quando não há
// ambiguidade; fabricante é o único caso que precisa do modelo, e a decisão tipada do Jev custa ~0,002 crédito.

export type Scope = z.infer<typeof ClaimScope>;

export function scopeByClass(s: Pick<Source, 'source_class'>): Scope | null {
  if (s.source_class === 'regulator' || s.source_class === 'standard_body' || s.source_class === 'independent_test') return 'geral';
  if (s.source_class === 'retailer_listing') return 'produto';
  return null;
}

export function scopeQuestion(c: Pick<Claim, 'statement' | 'quote' | 'claim_type'>, s: Pick<Source, 'publisher' | 'title'>): ChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      `Evidência (${c.claim_type}): "${c.statement}". Trecho literal: "${c.quote.slice(0, 300)}". ` +
      `Fonte: ${s.publisher}, documento "${(s.title ?? '').slice(0, 120)}". O que a evidência afirma vale para o quê?`,
    criteria: {
      produto: 'ficha, anúncio ou página de UM modelo: o dado (medida, peso suportado, garantia, composição) vale só para esse produto',
      marca: 'guia, tabela, FAQ ou página institucional do fabricante falando dos seus produtos, tamanhos ou tipos em geral',
      geral: 'norma, regulamento, órgão regulador ou laboratório: vale para qualquer produto',
    },
  };
}

export async function assignScopes(claims: Claim[], sources: Map<string, Source>, decide: Decider = jevDecide, batch = 20): Promise<Map<string, Scope>> {
  const out = new Map<string, Scope>();
  const pending: [Claim, Source][] = [];
  for (const c of claims) {
    const s = sources.get(c.source_id);
    if (!s) continue;
    const d = scopeByClass(s);
    if (d) out.set(c.id, d);
    else pending.push([c, s]);
  }
  for (let i = 0; i < pending.length; i += batch) {
    const slice = pending.slice(i, i + batch);
    const questions = Object.fromEntries(slice.map(([c, s]) => [c.id, scopeQuestion(c, s)]));
    const answers = await decide('Classifique o alcance de cada evidência de um site editorial sobre compras.', questions);
    for (const [c] of slice) {
      const a = answers[c.id];
      if (a && ClaimScope.safeParse(a.choice).success) out.set(c.id, a.choice as Scope);
    }
  }
  return out;
}

// Grava o alcance nas evidências que não têm (ou em todas, com onlyMissing=false).
export async function backfillScopes(decide: Decider = jevDecide, onlyMissing = true): Promise<{ total: number; set: number; by: Record<string, number> }> {
  const sources = new Map(loadSources().map((s) => [s.id, s]));
  const claims = loadClaims().filter((c) => !onlyMissing || !c.scope);
  const scopes = await assignScopes(claims, sources, decide);
  const by: Record<string, number> = {};
  let set = 0;
  for (const c of claims) {
    const sc = scopes.get(c.id);
    if (!sc) continue;
    writeJson(join(CLAIMS_DIR, `${c.id}.json`), { ...c, scope: sc });
    set++;
    by[sc] = (by[sc] ?? 0) + 1;
  }
  return { total: claims.length, set, by };
}
