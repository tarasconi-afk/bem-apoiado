import { editorLessonsPrompt } from '../editor-lessons.ts';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SourceClass, TopicBrief } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { computeLearning, plannerHints } from '../learning.ts';
import { jevDecide, usefulnessQuestion, type Decider } from '../jev.ts';
import { writeStage } from '../runs.ts';
import { creditsThisMonth, SearchError, webSearch, type SearchResult } from '../search.ts';
import { snapshot } from '../snapshot.ts';
import { DATA, loadSources, loadTopics, TOPICS_DIR, writeJson } from '../store.ts';
import { loadTopic } from './research.ts';

// Descobre fontes para uma pauta: LLM sugere consultas → Tavily → só domínios do cadastro entram →
// snapshot. Domínio fora do cadastro vira SUGESTÃO no relatório, nunca fonte automática.

const Registry = z.object({
  allow: z.array(z.object({ host: z.string(), path: z.string().optional(), publisher: z.string(), source_class: SourceClass, aliases: z.array(z.string()).optional(), kinds: z.array(z.string()).optional() })),
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
Consulta sem "include_domains" sempre com o nome do produto (ex.: "colchão de espuma densidade fabricante"): "ficha técnica", "especificações" ou "norma técnica" sem o produto trazem artigos de indústria e de sistemas de gestão, que o editor bloqueia.
Cubra as perguntas da pauta. No máximo o número de consultas pedido.${editorLessonsPrompt()}`;

// Fabricantes do cadastro que fazem os tipos da pauta (campo "kinds"). Sem isto o planejador buscou
// cadeira de escritório no site da Probel (colchões) e ignorou Cavaletti, Flexform e Frisokar (21/10).
// Só conta como coberta a busca restrita ao site daquele fabricante. Uma busca com os 5 sites juntos devolve
// só o maior: em 22/10 o planejador juntou Flexform, Cavaletti, Frisokar… numa consulta, as buscas por
// fabricante foram puladas e a cadeira saiu de novo só com Flexform.
// Site que bloqueia a VPS (403): lê pela Tavily. Em 22/10 as 4 fichas da XT Racer aprovadas na triagem
// voltaram 403 e a cadeira seguiu só com Flexform.
export async function snapshotOrTavily(input: Parameters<typeof snapshot>[0], snap = snapshot) {
  try {
    return await snap(input);
  } catch (e) {
    if (!/^HTTP (401|403|429) /.test((e as Error).message)) throw e;
    return snap({ ...input, via: 'tavily' });
  }
}

export function makerQueries(queries: { q: string; include_domains?: string[] }[], makers: { host: string }[], primary: string, max = 3) {
  return makers
    .filter((m) => !queries.some((q) => q.include_domains?.length === 1 && q.include_domains[0] === m.host))
    .slice(0, max)
    .map((m) => ({ q: `${primary} ficha técnica especificações`, include_domains: [m.host] }));
}

export function makersFor(kinds: string[], reg: Registry): Registry['allow'] {
  return reg.allow.filter((a) => a.source_class === 'manufacturer' && a.kinds?.some((k) => kinds.includes(k)));
}

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
  opts: { maxSearches?: number; maxSources?: number; makerSearches?: number } = {},
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
  const makers = makersFor(topic.product_kinds, reg);

  const Plan = z.object({
    queries: z.array(z.object({ q: z.string().min(5), include_domains: z.array(z.string()).optional() })).min(1).max(maxSearches),
  });
  const plan = await callJson(
    {
      role: 'extractor',
      system: planSystem(),
      user:
        `Pauta: "${topic.primary_query}"\nPerguntas:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n` +
        (makers.length ? `\nFabricantes cadastrados que fazem este produto (use os domínios deles): ${makers.map((m) => `${m.publisher} (${m.host})`).join(', ')}\n` : `\nNenhum fabricante cadastrado faz este produto: NÃO mire fabricantes de outros produtos.\n`) +
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
  const queries: { q: string; include_domains?: string[] }[] = plan.data.queries.slice(0, maxSearches);
  // Garantido, mesmo que o planejador esqueça: uma busca no site de cada fabricante do tipo (até 3).
  // Fabricantes que a pauta ainda não leu vêm primeiro: a página precisa de mais de uma marca (21/10: base box
  // e cadeira ficaram presas a Ortobom/Probel e a Flexform).
  const srcs = new Map(loadSources().map((x) => [x.id, x]));
  const withEvidence = new Set(topic.source_ids.map((id) => srcs.get(id)).filter((x) => x?.source_class === 'manufacturer').map((x) => x!.publisher));
  // Entre os não lidos, primeiro os que a pauta nunca buscou sozinhos: senão os 3 primeiros do cadastro
  // voltam toda vez e marca cadastrada depois (XT Racer, ThunderX3, 22/10) nunca é buscada.
  // Marca citada pelo editor no pedido (chega como lacuna) vai na frente de tudo.
  const tried = searchedAlone(join(DATA, 'runs'), slug);
  const fresh = orderMakers(makers, { named: topic.evidence_gaps.join(' '), withEvidence, tried });
  queries.push(...makerQueries(queries, fresh, topic.primary_query, opts.makerSearches ?? 3));
  // Menos de 2 fabricantes com fonte na pauta (ou nenhum cadastrado): 2 buscas abertas. O que vier de fora do
  // cadastro não entra como fonte; vira sugestão em "Domínios novos" para o editor aprovar.
  if (withEvidence.size < 2) {
    const label = loadNiche().product_kinds.find((k) => topic.product_kinds.includes(k.id))?.label ?? topic.primary_query;
    queries.push({ q: `${label} fabricante ficha técnica especificações` }, { q: `${label} norma técnica requisitos Brasil` });
  }
  for (const q of queries) {
    // Uma consulta recusada pela Tavily (HTTP 4xx) não derruba a descoberta inteira; teto e chave derrubam.
    let results: SearchResult[];
    try {
      results = await webSearch(q.q, { maxResults: 8, ...(q.include_domains?.length ? { includeDomains: q.include_domains } : {}) });
    } catch (e) {
      if (!(e instanceof SearchError) || e.code !== 'HTTP') throw e;
      report.snapshot_errors.push({ url: `busca: ${q.q}`, error: e.message.slice(0, 200) });
      results = [];
    }
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
    // Na mesma classe, marca que a pauta ainda não tem vem antes: em 22/10 uma ficha da XT Racer passou na
    // triagem (0,98) e perdeu a vaga para a 4ª página da Flexform, e a cadeira seguiu com uma marca só.
    .sort((a, b) => weight[b.source_class]! - weight[a.source_class]! || Number(withEvidence.has(a.publisher)) - Number(withEvidence.has(b.publisher)) || rank(b) - rank(a))
    .filter((c) => {
      const n = perPublisher.get(c.publisher) ?? 0;
      if (n >= 4) return false;
      perPublisher.set(c.publisher, n + 1);
      return true;
    })
    .slice(0, maxSources);

  for (const c of chosen) {
    try {
      const { source, created } = await snapshotOrTavily({ url: c.url, publisher: c.publisher, sourceClass: c.source_class });
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
  // Sufixo público (gov.br, com.br...) cobriria milhares de sites: aprovar "gov.br" liberou prefeituras
  // e diários oficiais como "regulador" (21/10). Só domínio de um publicador específico.
  if (op === 'allow' && isPublicSuffix(h)) throw new Error(`${h} é um sufixo público, não um site: aprove o domínio do órgão ou da empresa (ex.: inmetro.gov.br)`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const reg = Registry.parse(raw);
  if (reg.allow.some((a) => a.host === h && !a.path) || reg.block.includes(h)) return false;
  if (op === 'allow') {
    if (!publisher || !sourceClass) throw new Error('aprovar exige nome do publicador e classe da fonte');
    // Fabricante aprovado herda os tipos das pautas em que o site apareceu: a próxima busca já mira nele.
    const seen = new Set(domainCandidates(join(DATA, 'runs'), reg).find((c) => c.host === h)?.topics ?? []);
    const kinds = [...new Set(loadTopics().filter((t) => seen.has(t.slug)).flatMap((t) => t.product_kinds))];
    raw.allow.push({ host: h, publisher, source_class: SourceClass.parse(sourceClass), ...(sourceClass === 'manufacturer' && kinds.length ? { kinds } : {}) });
  } else raw.block.push(h);
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  return true;
}

const SUFFIX_2 = /^(gov|com|org|net|edu|ind|art|mil|jus|leg|mp|blog|eco|emp|tec|app|dev)\.br$/;
export const isPublicSuffix = (h: string) => SUFFIX_2.test(h) || /^[a-z]{2,}$/.test(h) || /^(co|com|org|gov|ac)\.[a-z]{2}$/.test(h);

// Prefeituras, estados e diários oficiais (licitação, edital): aparecem muito na busca e nunca são fonte.
const NOISE = /(\.(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)\.gov\.br|^pncp\.gov\.br|imprensaoficial|diario|licitac)/;

export function orderMakers<M extends { host: string; publisher: string }>(makers: M[], o: { named: string; withEvidence: Set<string>; tried: Set<string> }): M[] {
  const text = o.named.toLowerCase();
  const rank = (m: M) =>
    // Marca que já é fonte não sobe por ser citada: em 22/10 o pedido dizia "usa quase só a Flexform" e a
    // Flexform ganhou a primeira busca de novo.
    o.withEvidence.has(m.publisher) ? 3 : text.includes(m.publisher.toLowerCase()) || text.includes(m.host.split('.')[0]!) ? 0 : o.tried.has(m.host) ? 2 : 1;
  return makers.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

// Sites que já tiveram uma busca só deles nesta pauta (relatórios de descoberta anteriores).
export function searchedAlone(runsDir: string, slug: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(runsDir)) return out;
  for (const run of readdirSync(runsDir)) {
    const f = join(runsDir, run, 'discover.json');
    if (!existsSync(f)) continue;
    try {
      const d = JSON.parse(readFileSync(f, 'utf8')) as { topic?: string; queries?: { include_domains?: string[] }[] };
      if (d.topic !== slug) continue;
      for (const q of d.queries ?? []) if (q.include_domains?.length === 1) out.add(q.include_domains[0]!);
    } catch {
      continue;
    }
  }
  return out;
}

// Domínios que apareceram nas buscas mas não estão no cadastro: candidatos para o editor aprovar.
// Palavras do nicho (tipos de produto e categorias): um domínio só vira sugestão se alguma página dele que apareceu
// nas buscas fala do produto. 23/10: o editor bloqueou um a um sites de ERP e indústria com "Ficha técnica: o que é,
// como fazer e modelos", que vinham das buscas por "<pauta> ficha técnica especificações".
const NICHE_STOP = new Set(['trabalho', 'suporte', 'outro', 'office', 'avulso', 'para', 'home', 'como', 'qual']);
export function nicheTerms(): string[] {
  try {
    const n = loadNiche();
    const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return [...new Set([...n.product_kinds.map((k) => k.label), ...n.categories.map((c) => c.label)].flatMap((l) => norm(l).split(/[^a-z0-9]+/)).filter((w) => w.length >= 4 && !NICHE_STOP.has(w)))];
  } catch {
    return []; // sem nicho legível: não filtra
  }
}

export function domainCandidates(runsDir: string, reg: Registry, terms: string[] = nicheTerms()): { host: string; hits: number; topics: string[]; example: { url: string; title: string } }[] {
  const out = new Map<string, { host: string; hits: number; topics: Set<string>; example: { url: string; title: string }; relevant: boolean }>();
  // Menção a norma, regulador ou mobiliário conta como do nicho: o título de documento oficial raramente cita o produto
  // ("NR17 - Tudo o que você precisa saber", "Volume VII - Mobiliário e Equipamento Escolar"). Órgão público inteiro não
  // conta: ANTT e Cofeci também aparecem nas buscas.
  const about = (s: { url: string; title: string }) => {
    if (!terms.length || /\b(nr[\s-]?17|nbr|abnt|inmetro|anvisa|mobili[aá]rio)\b/i.test(`${s.title} ${s.url}`)) return true;
    const t = `${s.title} ${s.url}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return terms.some((w) => t.includes(w));
  };
  if (!existsSync(runsDir)) return [];
  for (const run of readdirSync(runsDir)) {
    const f = join(runsDir, run, 'discover.json');
    if (!existsSync(f)) continue;
    let d: { topic?: string; suggestions?: { host: string; url: string; title: string }[] };
    try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const s of d.suggestions ?? []) {
      const host = s.host.replace(/^www\./, '');
      if (classify(`https://${host}/`, reg) !== 'unknown' || NOISE.test(host) || isPublicSuffix(host)) continue;
      const c = out.get(host) ?? { host, hits: 0, topics: new Set<string>(), example: { url: s.url, title: s.title }, relevant: false };
      c.hits++;
      // Exemplo mostrado ao editor: a página que fala do produto, se houver.
      if (!c.relevant && about(s)) { c.relevant = true; c.example = { url: s.url, title: s.title }; }
      if (d.topic) c.topics.add(d.topic);
      out.set(host, c);
    }
  }
  return [...out.values()].filter((c) => c.relevant).map(({ relevant: _, ...c }) => ({ ...c, topics: [...c.topics] })).sort((a, b) => b.topics.length - a.topics.length || b.hits - a.hits);
}
