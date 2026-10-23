import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Claim, ClaimType, checkClaim, normalizeForMatch, TopicBrief, type Source } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { jevDecide, usefulnessQuestion, type Decider } from '../jev.ts';
import { buildIndex, CLAIMS_DIR, DATA, sourceText, TOPICS_DIR, writeJson } from '../store.ts';
import { writeStage } from '../runs.ts';

const CHUNK = 14_000;
const OVERLAP = 600;
const MAX_CHUNKS_PER_SOURCE = 3;
const TRIAGE_CANDIDATES = 6;
const STOP = new Set(['ou', 'de', 'do', 'da', 'e', 'o', 'a', 'para', 'com', 'qual', 'como', 'que', 'melhor', 'vale', 'pena']);

// Só trechos que mencionam os termos da pauta vão ao extrator, no máximo 3 por fonte (os com mais menções).
export function relevantChunks(text: string, terms: string[], limit = MAX_CHUNKS_PER_SOURCE): string[] {
  const norm = (t: string) => normalizeForMatch(t);
  const ts = terms.map(norm).filter((t) => t.length >= 2);
  return chunkText(text)
    .map((c) => ({ c, hits: ts.reduce((n, t) => n + (norm(c).split(t).length - 1), 0) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.c);
}

export function topicTerms(topic: TopicBrief): string[] {
  if (topic.focus_terms.length) return topic.focus_terms;
  return topic.primary_query.split(/\s+/).filter((w) => !STOP.has(w.toLowerCase()));
}

export function loadTopic(slug: string): TopicBrief {
  const p = join(DATA, 'topics', `${slug}.json`);
  if (!existsSync(p)) throw new Error(`pauta não encontrada: ${p}`);
  return TopicBrief.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK) return [text];
  const out: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK - OVERLAP) {
    out.push(text.slice(start, start + CHUNK));
    if (start + CHUNK >= text.length) break;
  }
  return out;
}

// Id determinístico: o mesmo trecho da mesma fonte vira sempre o mesmo claim, em qualquer pauta.
export function claimIdFor(sourceId: string, quote: string): string {
  return 'clm_' + createHash('sha256').update(`${sourceId}\n${normalizeForMatch(quote)}`).digest('hex').slice(0, 12);
}

const SYSTEM = `Você extrai evidências LITERAIS de um documento para responder perguntas de uma pauta editorial.

Regras obrigatórias:
1. "quote" é uma cópia EXATA, caractere por caractere, de um trecho contíguo do documento: uma ou duas frases, entre 30 e 500 caracteres. Não corrija, não resuma, não junte trechos de lugares diferentes, não traduza. Um programa vai procurar o trecho no documento e descartar o que não encontrar.
2. Só inclua trechos que respondem diretamente a uma das perguntas. Prefira trechos com informação concreta (definição, requisito, número, condição).
3. "statement" é uma paráfrase fiel e curta, em português, do que o trecho afirma. Não acrescente nada que o trecho não diga. Se a fonte é um fabricante falando dos produtos em geral (e não da ficha do próprio produto), comece com "Segundo <fabricante>,".
4. "claim_type": spec = dado técnico declarado; certification = certificação de produto; regulation = o que norma ou portaria exige; definition = definição de termo; availability = produto à venda numa data.
5. Se nada no trecho responde às perguntas, devolva "candidates": [].
6. No máximo 10 candidatos, sem repetir a mesma informação.`;

export interface ResearchReport {
  run_id: string;
  topic: string;
  accepted: { claim_id: string; question_id: string; source_id: string; new: boolean }[];
  rejected: { source_id: string; question_id: string; reason: string; quote: string }[];
  coverage: Record<string, number>;
  unanswered: string[];
  usage: { input_tokens: number; output_tokens: number; calls: number };
  errors: { source_id: string; error: string }[];
  skipped_sources: string[];
  triage: { source_id: string; chunk: number; keep: boolean; p_useful: number }[];
}

export async function research(
  slug: string,
  runId: string,
  fetchImpl?: FetchLike,
  only?: string[],
  decide: Decider | null = jevDecide,
): Promise<ResearchReport> {
  const topic = loadTopic(slug);
  if (topic.source_ids.length === 0) throw new Error(`pauta ${slug} sem fontes: rode discover antes`);
  const idx = buildIndex();
  const qIds = topic.questions.map((q) => q.id) as [string, ...string[]];
  // Enum fechado: o modelo só pode apontar para perguntas que existem na pauta.
  const Out = z.object({
    candidates: z
      .array(z.object({ question_id: z.enum(qIds), quote: z.string(), claim_type: ClaimType, statement: z.string() }))
      .max(12),
  });

  const report: ResearchReport = {
    run_id: runId,
    topic: slug,
    accepted: [],
    rejected: [],
    coverage: Object.fromEntries(qIds.map((q) => [q, 0])),
    unanswered: [],
    usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
    errors: [],
    skipped_sources: [],
    triage: [],
  };
  const questionsText = topic.questions.map((q) => `- ${q.id}: ${q.text}`).join('\n');

  // Sem --only, lê só fontes que a pesquisa ainda não leu para esta pauta.
  const pending = topic.source_ids.filter((s) => (only?.length ? only.includes(s) : !topic.researched_source_ids.includes(s)));
  for (const sourceId of pending) {
    const source = idx.sources.get(sourceId);
    const text = sourceText(sourceId);
    if (!source || !text) {
      report.errors.push({ source_id: sourceId, error: 'fonte ou texto ausente' });
      continue;
    }
    // 1) filtro grátis por termos; 2) triagem Jev (centavos) decide quais trechos o extrator lê.
    let chunks = relevantChunks(text, topicTerms(topic), decide ? TRIAGE_CANDIDATES : MAX_CHUNKS_PER_SOURCE);
    if (decide && chunks.length > 0) {
      try {
        const q = usefulnessQuestion(topic.primary_query, topic.questions.map((x) => x.text));
        const kept: string[] = [];
        for (const [i, c] of chunks.entries()) {
          const a = (await decide(c, q)).util;
          const p = a?.probabilities?.sim ?? 0;
          report.triage.push({ source_id: sourceId, chunk: i, keep: p >= 0.5, p_useful: p });
          if (p >= 0.5) kept.push(c);
        }
        chunks = kept.slice(0, MAX_CHUNKS_PER_SOURCE);
      } catch (e) {
        report.errors.push({ source_id: sourceId, error: `triagem indisponível, usando filtro por termos: ${(e as Error).message.slice(0, 120)}` });
        chunks = chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
      }
    }
    if (chunks.length === 0) report.skipped_sources.push(sourceId);
    for (const [ci, chunk] of chunks.entries()) {
      try {
        const r = await callJson(
          {
            role: 'extractor',
            system: SYSTEM,
            user: `Fonte: ${source.publisher} (${source.source_class})\nTítulo: ${source.title ?? '-'}\n\nPerguntas:\n${questionsText}\n\nDocumento (parte ${ci + 1}):\n"""\n${chunk}\n"""`,
            schema: Out,
            schemaName: 'evidence_candidates',
            maxTokens: 6000,
          },
          fetchImpl,
        );
        report.usage.calls++;
        report.usage.input_tokens += r.usage.input_tokens;
        report.usage.output_tokens += r.usage.output_tokens;
        for (const c of r.data.candidates) accept(c, source, idx, runId, report);
      } catch (e) {
        report.errors.push({ source_id: sourceId, error: (e as Error).message });
      }
    }
  }
  report.unanswered = qIds.filter((q) => report.coverage[q] === 0);
  const failed = new Set(report.errors.filter((e) => !e.error.startsWith('triagem')).map((e) => e.source_id));
  const done = pending.filter((s) => !failed.has(s));
  writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...topic, researched_source_ids: [...new Set([...topic.researched_source_ids, ...done])] }));
  writeStage(runId, 'research', { ...report, credits: creditsSpent() });
  return report;
}

function accept(
  c: { question_id: string; quote: string; claim_type: z.infer<typeof ClaimType>; statement: string },
  source: Source,
  idx: ReturnType<typeof buildIndex>,
  runId: string,
  report: ResearchReport,
): void {
  const reject = (reason: string): void => {
    report.rejected.push({ source_id: source.id, question_id: c.question_id, reason, quote: c.quote.slice(0, 200) });
  };

  const id = claimIdFor(source.id, c.quote);
  const existing = idx.claims.get(id);
  const parsed = Claim.safeParse({
    id,
    source_id: source.id,
    quote: c.quote.trim(),
    claim_type: c.claim_type,
    statement: c.statement.trim(),
    captured_at: existing?.captured_at ?? new Date().toISOString(),
    question_ids: [...new Set([...(existing?.question_ids ?? []), c.question_id])],
    run_id: existing?.run_id ?? runId,
  });
  if (!parsed.success) return reject(`SCHEMA: ${parsed.error.issues[0]?.message ?? 'inválido'}`);
  // Mesma checagem do gate final: trecho literal e classe de fonte permitida para o tipo.
  const problems = checkClaim(parsed.data, idx);
  if (problems.length > 0) return reject(problems.map((p) => p.code).join(','));

  writeJson(join(CLAIMS_DIR, `${id}.json`), parsed.data);
  idx.claims.set(id, parsed.data);
  if (!report.accepted.some((a) => a.claim_id === id && a.question_id === c.question_id)) {
    report.accepted.push({ claim_id: id, question_id: c.question_id, source_id: source.id, new: !existing });
    report.coverage[c.question_id] = (report.coverage[c.question_id] ?? 0) + 1;
  }
}

// Releitura dirigida (23/10): a pesquisa só lê fonte ainda não lida pela pauta, e uma pergunta nova não voltava às
// fontes antigas. No "solteirão ou viúva", a ficha "Colchão Solteirão… Probel Sigma Plus (100x200x24cm)" já estava
// lida (para o peso suportado) e a medida do solteirão nunca virou evidência. Aqui: palavras raras do pedido (presentes
// em poucas fontes da pauta, como "solteirão") apontam as fontes já lidas que valem reler com a pergunta nova.
export function sourcesWorthRereading(slug: string, request: string, max = 4): string[] {
  const topic = loadTopic(slug);
  const read = topic.source_ids.filter((s) => topic.researched_source_ids.includes(s));
  if (!read.length) return [];
  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const texts = new Map(read.map((s) => [s, fold(sourceText(s) ?? '')]));
  const words = [...new Set(fold(request).split(/[^a-z0-9]+/).filter((w) => w.length >= 6))];
  const limit = Math.max(2, Math.ceil(read.length * 0.3));
  const rare = words.filter((w) => {
    const n = [...texts.values()].filter((t) => t.includes(w)).length;
    return n >= 1 && n <= limit;
  });
  if (!rare.length) return [];
  return read.filter((s) => rare.some((w) => texts.get(s)!.includes(w))).slice(0, max);
}
