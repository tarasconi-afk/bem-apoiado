import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Claim, ClaimType, checkClaim, normalizeForMatch, TopicBrief, type Source } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { buildIndex, CLAIMS_DIR, DATA, sourceText, writeJson } from '../store.ts';
import { writeStage } from '../runs.ts';

const CHUNK = 14_000;
const OVERLAP = 600;

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
3. "statement" é uma paráfrase fiel e curta, em português, do que o trecho afirma. Não acrescente nada que o trecho não diga. Se a fonte é um fabricante falando de colchões em geral (e não da ficha do próprio produto), comece com "Segundo <fabricante>,".
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
}

export async function research(slug: string, runId: string, fetchImpl?: FetchLike, only?: string[]): Promise<ResearchReport> {
  const topic = loadTopic(slug);
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
  };
  const questionsText = topic.questions.map((q) => `- ${q.id}: ${q.text}`).join('\n');

  for (const sourceId of topic.source_ids.filter((s) => !only?.length || only.includes(s))) {
    const source = idx.sources.get(sourceId);
    const text = sourceText(sourceId);
    if (!source || !text) {
      report.errors.push({ source_id: sourceId, error: 'fonte ou texto ausente' });
      continue;
    }
    for (const [ci, chunk] of chunkText(text).entries()) {
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
  writeStage(runId, 'research', report);
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
