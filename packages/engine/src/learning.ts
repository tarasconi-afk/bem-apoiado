import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { referencedClaimIds } from '@bem-apoiado/core';
import { buildIndex, loadPages, loadTopics, RUNS_DIR } from './store.ts';

// Aprendizado acumulado: tudo é recalculado a partir do histórico em data/ (fontes, evidências,
// runs, pautas, páginas). Nada é "lembrado" fora dos dados, então o aprendizado é auditável e
// sobrevive à troca de sessão, de modelo e de nicho.

export interface DomainStats {
  host: string;
  publisher: string;
  researched: number; // fontes deste domínio que a pesquisa já leu
  productive: number; // dessas, quantas renderam ao menos uma evidência
  claims: number;
  cited_in_approved: number; // evidências usadas em página aprovada
  rejected_quotes: number; // citações propostas que não existiam na fonte
  yield: number; // (productive + 1) / (researched + 2): Laplace, para domínio novo não ser zerado
}

export interface Learning {
  domains: Map<string, DomainStats>;
  unproductiveUrls: Set<string>; // lidas pela pesquisa e sem nenhuma evidência
  recurringGaps: { gap: string; topic: string }[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function computeLearning(): Learning {
  const idx = buildIndex();
  const topics = loadTopics();
  const researched = new Set(topics.flatMap((t) => t.researched_source_ids));
  const claimsBySource = new Map<string, number>();
  for (const c of idx.claims.values()) claimsBySource.set(c.source_id, (claimsBySource.get(c.source_id) ?? 0) + 1);
  const cited = new Set(loadPages().filter((p) => p.status !== 'draft').flatMap(referencedClaimIds));

  const rejectedBySource = new Map<string, number>();
  if (existsSync(RUNS_DIR)) {
    for (const run of readdirSync(RUNS_DIR)) {
      const f = join(RUNS_DIR, run, 'research.json');
      if (!existsSync(f)) continue;
      try {
        const r = JSON.parse(readFileSync(f, 'utf8')) as { rejected?: { source_id: string; reason: string }[] };
        for (const x of r.rejected ?? []) {
          if (x.reason.includes('QUOTE_NOT_IN_SOURCE')) rejectedBySource.set(x.source_id, (rejectedBySource.get(x.source_id) ?? 0) + 1);
        }
      } catch {
        // run corrompido não derruba o aprendizado
      }
    }
  }

  const domains = new Map<string, DomainStats>();
  const unproductiveUrls = new Set<string>();
  for (const s of idx.sources.values()) {
    const host = hostOf(s.final_url);
    const d = domains.get(host) ?? { host, publisher: s.publisher, researched: 0, productive: 0, claims: 0, cited_in_approved: 0, rejected_quotes: 0, yield: 0 };
    const n = claimsBySource.get(s.id) ?? 0;
    // Fonte com evidência foi lida, mesmo que seja de antes da memória de pauta existir.
    if (researched.has(s.id) || n > 0) {
      d.researched++;
      if (n > 0) d.productive++;
      else unproductiveUrls.add(s.final_url);
    }
    d.claims += n;
    d.cited_in_approved += [...idx.claims.values()].filter((c) => c.source_id === s.id && cited.has(c.id)).length;
    d.rejected_quotes += rejectedBySource.get(s.id) ?? 0;
    domains.set(host, d);
  }
  for (const d of domains.values()) d.yield = (d.productive + 1) / (d.researched + 2);

  const recurringGaps = topics.flatMap((t) => t.evidence_gaps.map((gap) => ({ gap, topic: t.slug })));
  return { domains, unproductiveUrls, recurringGaps };
}

// Texto curto para o planejador de buscas: o que já rendeu, o que não rende e o que nunca foi achado.
export function plannerHints(l: Learning): string {
  const ds = [...l.domains.values()].filter((d) => d.researched > 0);
  const good = ds.filter((d) => d.productive > 0).sort((a, b) => b.cited_in_approved - a.cited_in_approved || b.claims - a.claims).slice(0, 8);
  const bad = ds.filter((d) => d.researched >= 2 && d.yield < 0.34).slice(0, 6);
  const lines: string[] = [];
  if (good.length) lines.push(`Domínios que já renderam evidências úteis: ${good.map((d) => `${d.host} (${d.claims} evidências)`).join(', ')}.`);
  if (bad.length) lines.push(`Domínios que raramente rendem (evite, a não ser que a pergunta exija): ${bad.map((d) => d.host).join(', ')}.`);
  if (l.unproductiveUrls.size) lines.push(`Páginas já lidas sem nada útil (não adianta buscar de novo): ${[...l.unproductiveUrls].slice(0, 6).join(' ; ')}.`);
  if (l.recurringGaps.length)
    lines.push(
      `Informações que buscas anteriores NÃO acharam em texto (tente formatos diferentes: PDF, manual, ficha técnica, norma): ${l.recurringGaps
        .slice(0, 6)
        .map((g) => g.gap)
        .join(' | ')}.`,
    );
  return lines.join('\n');
}
