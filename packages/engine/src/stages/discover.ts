import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SourceClass, TopicBrief } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { jevDecide, usefulnessQuestion, type Decider } from '../jev.ts';
import { writeStage } from '../runs.ts';
import { creditsThisMonth, webSearch, type SearchResult } from '../search.ts';
import { snapshot } from '../snapshot.ts';
import { DATA, TOPICS_DIR, writeJson } from '../store.ts';
import { loadTopic } from './research.ts';

// Descobre fontes para uma pauta: LLM sugere consultas → Tavily → só domínios do cadastro entram →
// snapshot. Domínio fora do cadastro vira SUGESTÃO no relatório, nunca fonte automática.

const Registry = z.object({
  allow: z.array(z.object({ host: z.string(), path: z.string().optional(), publisher: z.string(), source_class: SourceClass })),
  block: z.array(z.string()),
});
type Registry = z.infer<typeof Registry>;

export function loadRegistry(): Registry {
  return Registry.parse(JSON.parse(readFileSync(join(DATA, 'registry', 'domains.json'), 'utf8')));
}

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function classify(url: string, reg: Registry): { publisher: string; source_class: SourceClass } | 'blocked' | 'unknown' {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'blocked';
  }
  const host = u.hostname.toLowerCase();
  if (reg.block.some((d) => hostMatches(host, d))) return 'blocked';
  const hit = reg.allow.find((a) => hostMatches(host, a.host) && (!a.path || u.pathname.startsWith(a.path)));
  if (hit) return { publisher: hit.publisher, source_class: hit.source_class };
  // gov.br fora dos caminhos cadastrados: órgão não identificado, não entra sozinho.
  return 'unknown';
}

const PLAN_SYSTEM = `Você planeja buscas na web para uma pauta de um site que só usa fontes primárias: órgãos reguladores (Inmetro, Anvisa, Diário Oficial), normas técnicas (ABNT) e páginas oficiais de fabricantes.
Gere consultas em português do Brasil que tendem a trazer ESSAS fontes, não lojas, blogs ou vídeos.
Use "include_domains" quando a consulta mira um domínio específico (ex.: ["gov.br"] para Inmetro, ["probel.com.br","simmons.com.br"] para fabricantes).
Cubra as perguntas da pauta. No máximo o número de consultas pedido.`;

export interface DiscoverReport {
  run_id: string;
  topic: string;
  queries: { q: string; include_domains?: string[]; results: number }[];
  added: { source_id: string; url: string; publisher: string; source_class: string; created: boolean }[];
  skipped_blocked: number;
  suggestions: { host: string; url: string; title: string }[];
  snapshot_errors: { url: string; error: string }[];
  tavily_credits_month: number;
  triage: { url: string; p_useful: number; keep: boolean }[];
}

export async function discoverSources(
  slug: string,
  runId: string,
  opts: { maxSearches?: number; maxSources?: number } = {},
  fetchImpl?: FetchLike,
  decide: Decider | null = jevDecide,
): Promise<DiscoverReport> {
  const topic = loadTopic(slug);
  const reg = loadRegistry();
  const maxSearches = opts.maxSearches ?? 8;
  const maxSources = opts.maxSources ?? 14;

  const Plan = z.object({
    queries: z.array(z.object({ q: z.string().min(5), include_domains: z.array(z.string()).optional() })).min(1).max(maxSearches),
  });
  const plan = await callJson(
    {
      role: 'extractor',
      system: PLAN_SYSTEM,
      user:
        `Pauta: "${topic.primary_query}"\nPerguntas:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n` +
        (topic.evidence_gaps.length
          ? `\nPRIORIDADE: uma tentativa anterior não achou fonte para estas lacunas. Concentre as consultas nelas:\n${topic.evidence_gaps.map((g) => `- ${g}`).join('\n')}\n`
          : '') +
        `\nGere até ${maxSearches} consultas.`,
      schema: Plan,
      schemaName: 'search_plan',
      maxTokens: 1500,
    },
    fetchImpl,
  );

  const report: DiscoverReport = {
    run_id: runId, topic: slug, queries: [], added: [], skipped_blocked: 0, suggestions: [], snapshot_errors: [], tavily_credits_month: 0, triage: [],
  };
  const candidates = new Map<string, SearchResult & { publisher: string; source_class: SourceClass }>();
  for (const q of plan.data.queries.slice(0, maxSearches)) {
    const results = await webSearch(q.q, { maxResults: 8, ...(q.include_domains?.length ? { includeDomains: q.include_domains } : {}) });
    report.queries.push({ q: q.q, ...(q.include_domains ? { include_domains: q.include_domains } : {}), results: results.length });
    for (const r of results) {
      const c = classify(r.url, reg);
      if (c === 'blocked') report.skipped_blocked++;
      else if (c === 'unknown') {
        const host = new URL(r.url).hostname;
        if (!report.suggestions.some((s) => s.host === host)) report.suggestions.push({ host, url: r.url, title: r.title });
      } else {
        const prev = candidates.get(r.url);
        if (!prev || prev.score < r.score) candidates.set(r.url, { ...r, ...c });
      }
    }
  }

  // Triagem Jev pelo título + resumo da busca: não captura página que não vai responder nada.
  if (decide) {
    const q = usefulnessQuestion(topic.primary_query, topic.questions.map((x) => x.text));
    for (const [url, c] of [...candidates]) {
      try {
        const p = (await decide(`${c.title}\n${c.url}\n${c.content}`, q)).util?.probabilities?.sim ?? 0;
        report.triage.push({ url, p_useful: p, keep: p >= 0.5 });
        if (p < 0.5) candidates.delete(url);
      } catch {
        break; // triagem indisponível: segue sem ela (o extrator ainda filtra depois)
      }
    }
  }

  // Ranking: regulador e norma primeiro, depois score; no máximo 4 páginas por publicador.
  const weight: Record<string, number> = { regulator: 3, standard_body: 3, independent_test: 2, manufacturer: 1, retailer_listing: 0, other: 0 };
  const perPublisher = new Map<string, number>();
  const chosen = [...candidates.values()]
    .sort((a, b) => weight[b.source_class]! - weight[a.source_class]! || b.score - a.score)
    .filter((c) => {
      const n = perPublisher.get(c.publisher) ?? 0;
      if (n >= 4) return false;
      perPublisher.set(c.publisher, n + 1);
      return true;
    })
    .slice(0, maxSources);

  for (const c of chosen) {
    try {
      const { source, created } = await snapshot({ url: c.url, publisher: c.publisher, sourceClass: c.source_class });
      report.added.push({ source_id: source.id, url: source.final_url, publisher: c.publisher, source_class: c.source_class, created });
    } catch (e) {
      report.snapshot_errors.push({ url: c.url, error: (e as Error).message.slice(0, 160) });
    }
  }

  const updated = TopicBrief.parse({ ...topic, source_ids: [...new Set([...topic.source_ids, ...report.added.map((a) => a.source_id)])] });
  writeJson(join(TOPICS_DIR, `${slug}.json`), updated);
  report.tavily_credits_month = creditsThisMonth();
  writeStage(runId, 'discover', { ...report, llm_credits: creditsSpent() });
  return report;
}
