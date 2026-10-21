import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SourceClass, TopicBrief } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { computeLearning, plannerHints } from '../learning.ts';
import { jevDecide, usefulnessQuestion, type Decider } from '../jev.ts';
import { writeStage } from '../runs.ts';
import { creditsThisMonth, webSearch, type SearchResult } from '../search.ts';
import { snapshot } from '../snapshot.ts';
import { DATA, TOPICS_DIR, writeJson } from '../store.ts';
import { loadTopic } from './research.ts';

// Descobre fontes para uma pauta: LLM sugere consultas → Tavily → só domínios do cadastro entram →
// snapshot. Domínio fora do cadastro vira SUGESTÃO no relatório, nunca fonte automática.

const Registry = z.object({
  allow: z.array(z.object({ host: z.string(), path: z.string().optional(), publisher: z.string(), source_class: SourceClass, aliases: z.array(z.string()).optional() })),
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

const planSystem = () => `Você planeja buscas na web para uma pauta de um site sobre ${loadNiche().scope} que só usa fontes primárias: órgãos reguladores, normas técnicas e páginas oficiais de fabricantes.
Reguladores e normas típicos deste tema:
${loadNiche().regulator_hints.map((h) => `- ${h}`).join('\n')}
Gere consultas em português do Brasil que tendem a trazer ESSAS fontes, não lojas, blogs ou vídeos.
Use "include_domains" quando a consulta mira um domínio específico (ex.: ["gov.br"] para um órgão federal, ou os domínios de fabricantes).
Cubra as perguntas da pauta. No máximo o número de consultas pedido.`;

export interface DiscoverReport {
  run_id: string;
  topic: string;
  queries: { q: string; include_domains?: string[]; results: number }[];
  added: { source_id: string; url: string; publisher: string; source_class: string; created: boolean }[];
  skipped_blocked: number;
  skipped_learned: number;
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
  // Aprendizado de TODAS as pautas anteriores: orienta o planejador e o ranking.
  const learning = computeLearning();
  const hints = plannerHints(learning);
  const maxSearches = opts.maxSearches ?? 8;
  const maxSources = opts.maxSources ?? 14;

  const Plan = z.object({
    queries: z.array(z.object({ q: z.string().min(5), include_domains: z.array(z.string()).optional() })).min(1).max(maxSearches),
  });
  const plan = await callJson(
    {
      role: 'extractor',
      system: planSystem(),
      user:
        `Pauta: "${topic.primary_query}"\nPerguntas:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n` +
        (topic.evidence_gaps.length
          ? `\nPRIORIDADE: uma tentativa anterior não achou fonte para estas lacunas. Concentre as consultas nelas:\n${topic.evidence_gaps.map((g) => `- ${g}`).join('\n')}\n`
          : '') +
        (hints ? `\nAprendizado de buscas anteriores deste site:\n${hints}\n` : '') +
        `\nGere até ${maxSearches} consultas.`,
      schema: Plan,
      schemaName: 'search_plan',
      maxTokens: 1500,
    },
    fetchImpl,
  );

  const report: DiscoverReport = {
    run_id: runId, topic: slug, queries: [], added: [], skipped_blocked: 0, skipped_learned: 0, suggestions: [], snapshot_errors: [], tavily_credits_month: 0, triage: [],
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
      } else if (learning.unproductiveUrls.has(r.url)) {
        report.skipped_learned++;
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
  const yieldOf = (url: string) => learning.domains.get(new URL(url).hostname.replace(/^www\./, ''))?.yield ?? 0.5;
  const rank = (c: { url: string; score: number }) => c.score * (0.5 + yieldOf(c.url));
  const perPublisher = new Map<string, number>();
  const chosen = [...candidates.values()]
    // Classe da fonte primeiro; dentro dela, o que o histórico mostrou que rende (yield) pesa junto do score da busca.
    .sort((a, b) => weight[b.source_class]! - weight[a.source_class]! || rank(b) - rank(a))
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

// Cadastro de domínios editado pelo painel (aprovação humana). Host normalizado, sem www.
export function editRegistry(op: 'allow' | 'block', host: string, publisher?: string, sourceClass?: SourceClass, path = join(DATA, 'registry', 'domains.json')): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new Error(`domínio inválido: ${host}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const reg = Registry.parse(raw);
  if (reg.allow.some((a) => a.host === h && !a.path) || reg.block.includes(h)) return false;
  if (op === 'allow') {
    if (!publisher || !sourceClass) throw new Error('aprovar exige nome do publicador e classe da fonte');
    raw.allow.push({ host: h, publisher, source_class: SourceClass.parse(sourceClass) });
  } else raw.block.push(h);
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  return true;
}

// Prefeituras, estados e diários oficiais (licitação, edital): aparecem muito na busca e nunca são fonte.
const NOISE = /(\.(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)\.gov\.br|^pncp\.gov\.br|imprensaoficial|diario|licitac)/;

// Domínios que apareceram nas buscas mas não estão no cadastro: candidatos para o editor aprovar.
export function domainCandidates(runsDir: string, reg: Registry): { host: string; hits: number; topics: string[]; example: { url: string; title: string } }[] {
  const out = new Map<string, { host: string; hits: number; topics: Set<string>; example: { url: string; title: string } }>();
  if (!existsSync(runsDir)) return [];
  for (const run of readdirSync(runsDir)) {
    const f = join(runsDir, run, 'discover.json');
    if (!existsSync(f)) continue;
    let d: { topic?: string; suggestions?: { host: string; url: string; title: string }[] };
    try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const s of d.suggestions ?? []) {
      const host = s.host.replace(/^www\./, '');
      if (classify(`https://${host}/`, reg) !== 'unknown' || NOISE.test(host)) continue;
      const c = out.get(host) ?? { host, hits: 0, topics: new Set<string>(), example: { url: s.url, title: s.title } };
      c.hits++;
      if (d.topic) c.topics.add(d.topic);
      out.set(host, c);
    }
  }
  return [...out.values()].map((c) => ({ ...c, topics: [...c.topics] })).sort((a, b) => b.topics.length - a.topics.length || b.hits - a.hits);
}
