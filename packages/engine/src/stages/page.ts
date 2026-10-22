import { join } from 'node:path';
import { checkPage, PageSpec, TopicBrief } from '@bem-apoiado/core';
import { creditsLeft, creditsSpent, LlmError, type FetchLike } from '../llm.ts';
import { newRunId } from '../runs.ts';
import { MODELS } from '../models.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, TOPICS_DIR, writeJson } from '../store.ts';
import { auditDraft, type AuditCache, type AuditFinding } from './audit.ts';
import { blockRefs, claimsForTopic, selectClaims, type Draft } from './draft-schema.ts';
import { duplicateBlocks } from './duplicates.ts';
import { applyPatches, refFromWhere, writePatches, type Issue } from './patch.ts';
import { loadTopic } from './research.ts';
import { reviewMetrics, reviewPage, type ReviewResult } from './review.ts';
import { loadThresholds } from '../feedback.ts';
import { applyEdits } from './edit.ts';
import { writeDraft } from './write.ts';

const MAX_FIX_ROUNDS = 3;
// Até quantos blocos sem prova a página pode perder no fim (por remoção) e ainda seguir para a revisão.
const SALVAGE_MAX = 3;
const MIN_CLAIMS = 8;

export type PageOutcome =
  | { status: 'PASS'; rounds: number; page: PageSpec; usage: Usage; review: ReviewResult }
  | { status: 'NOT_PUBLISHABLE'; rounds: number; page: PageSpec; usage: Usage; review: ReviewResult }
  | { status: 'SAFE_STOP'; reason: string; rounds: number; open_issues: string[]; usage: Usage };

interface Usage {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export function toPageSpec(draft: Draft, topic: TopicBrief, runId: string, auditVerdict: 'pass' | 'pending'): PageSpec {
  return PageSpec.parse({
    slug: topic.slug,
    page_type: topic.page_type,
    status: auditVerdict === 'pass' ? 'approved' : 'draft',
    title: draft.title,
    description: draft.description,
    primary_query: topic.primary_query,
    updated_at: new Date().toISOString().slice(0, 10),
    verdict: draft.verdict,
    sections: draft.sections,
    products: [],
    provenance: {
      run_id: runId,
      writer_model: process.env.BEM_MODEL_WRITER ?? MODELS.writer.id,
      auditor_model: auditVerdict === 'pass' ? MODELS.auditor.id : null,
      audit_verdict: auditVerdict,
    },
  });
}

// Regras de forma que não são integridade de evidência, mas também barram a página.
// ref null = problema da página inteira.
export function styleIssues(draft: Draft): Issue[] {
  const out: Issue[] = [];
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let total = 0;
  for (const u of blockRefs(draft)) {
    const n = words(u.text);
    total += n;
    if (u.text.includes('—')) out.push({ ref: u.ref, msg: 'remova o travessão (—).' });
    if (u.basis === 'framing' && n < 6) out.push({ ref: u.ref, msg: 'frase de transição incompleta; escreva uma frase completa ou remova o bloco.' });
    if (!u.ref.includes('.r') && n > 90) out.push({ ref: u.ref, msg: `parágrafo com ${n} palavras; encurte para no máximo 70.` });
  }
  // Resposta curta (a frase mais lida da página e a que a busca com IA cita): no máximo 3 frases, começa pela
  // resposta prática e nunca por norma ou regulador. "Trechos citados" é jargão do motor, não do leitor.
  const v = draft.verdict.text.trim();
  const sentences = v.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9])/).filter((x) => x.trim().length > 3).length;
  if (sentences > 3) out.push({ ref: 'verdict', msg: `resposta curta com ${sentences} frases; deixe em até 3, começando pela resposta prática para quem vai comprar.` });
  if (/^([Ss]egundo|[Dd]e acordo com|[Cc]onforme)\s+((a|o|os|as)\s+)?\p{Lu}/u.test(v)) out.push({ ref: 'verdict', msg: 'a resposta curta não pode abrir citando uma marca ("Segundo a Ortobom..."): comece pela resposta prática; a marca entra depois, se precisar.' });
  if (/^(segundo|conforme|de acordo com|no|na|nos|nas|o|a|os|as)?\s*(inmetro|abnt|nbr|nr[- ]?\d|anvisa|portaria|norma|regulamento|regula[cç][aã]o|trecho|anexo)/i.test(v)) out.push({ ref: 'verdict', msg: 'a resposta curta não pode abrir com norma, regulador ou anexo: comece pelo que o leitor deve escolher ou conferir.' });
  for (const u of blockRefs(draft)) if (/\b(nos|os|segundo os|dos) trechos? citados?\b/i.test(u.text)) out.push({ ref: u.ref, msg: 'não escreva "trechos citados" (é termo do motor): diga quem afirma ("segundo a Ortobom") ou o que não foi informado ("a ficha não informa").' });
  for (const sec of draft.sections) {
    if (sec.blocks.some((b) => b.kind === 'table')) continue;
    sec.blocks.forEach((b, i) => { if (b.kind !== 'table' && /tabela (abaixo|acima|a seguir|seguinte)/i.test(b.text)) out.push({ ref: `${sec.id}#${i}`, msg: 'o texto cita uma tabela que não existe nesta seção: traga a tabela ou escreva os dados no texto.' }); });
  }
  for (const d of duplicateBlocks(draft)) out.push({ ref: d.ref, msg: `repete o bloco ${d.of} (${Math.round(d.overlap * 100)}% das palavras): corte este bloco ou diga só o que ele acrescenta.` });
  if (draft.title.includes('—')) out.push({ ref: null, msg: 'title: remova o travessão (—).' });
  if (total > 1600) out.push({ ref: null, msg: `página com ${total} palavras; encurte para no máximo 1400, cortando o que não ajuda a decidir.` });
  // A decisão fecha a página: "escolher" no meio (ex.: "densidade e como escolher") não conta.
  const last = draft.sections.at(-1);
  if (!last || !/decidir|escolh|antes de comprar|na pr[aá]tica|o que (verificar|conferir)/i.test(last.heading)) out.push({ ref: null, msg: 'a última seção tem de ser "Como decidir", com 2 a 4 orientações condicionais ("se você..., ...") sustentadas pelas evidências.' });
  if (draft.sections.length < 3) out.push({ ref: null, msg: 'a página ficou com menos de 3 seções.' });
  return out;
}

const show = (i: Issue) => (i.ref ? `${i.ref}: ${i.msg}` : i.msg);

// Redator em camadas: o barato (Haiku) escreve; se a página não passar (auditoria não converge ou revisão
// reprova), uma segunda tentativa com o Sonnet, se houver orçamento. Avaliação de 21/10 na mesma pauta:
// Haiku 7,8 créditos, Sonnet 24,2, as duas aprovadas com notas de revisão parecidas.
export const ESCALATION_WRITER = 'claude-sonnet-5';
const ESCALATION_MIN_CREDITS = 30;
// Primeira tentativa que já custou isso não ganha a segunda (21/10: base box gastou ~30 no Haiku, com 2
// reservas de Sonnet 4.6 por 524, e mais 14 na escalada; terminou rascunho igual).
const ESCALATION_MAX_FIRST_SPEND = 15;

export async function buildPage(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  const before = creditsSpent();
  const first = await buildPageOnce(slug, runId, fetchImpl);
  const doomed = first.status === 'SAFE_STOP' && /INSUFFICIENT_EVIDENCE|BUDGET/.test(first.reason);
  const costly = creditsSpent() - before > ESCALATION_MAX_FIRST_SPEND;
  // Desligada por padrão (21/10: duas escaladas de 14 e 36,5 créditos terminaram em rascunho ou estouro do
  // teto). Página que não passa fica rascunho e o editor ajusta (2–5 créditos). BEM_ESCALATION=1 religa.
  if (process.env.BEM_ESCALATION !== '1') return first;
  if (first.status === 'PASS' || doomed || costly || process.env.BEM_MODEL_WRITER || creditsLeft() < ESCALATION_MIN_CREDITS) return first;
  const rid = newRunId(`${slug}-escalada`);
  writeStage(runId, 'escalation', { from: MODELS.writer.id, to: ESCALATION_WRITER, first: first.status, run: rid });
  process.env.BEM_MODEL_WRITER = ESCALATION_WRITER;
  try {
    return await buildPageOnce(slug, rid, fetchImpl);
  } finally {
    delete process.env.BEM_MODEL_WRITER;
  }
}

async function buildPageOnce(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  try {
    return await buildPageInner(slug, runId, fetchImpl);
  } catch (e) {
    // Falha de LLM (crédito, rede, saída inválida) vira parada segura com relatório, nunca página parcial.
    if (!(e instanceof LlmError)) throw e;
    const reason = `LLM_${e.code}: ${e.message.slice(0, 300)}`;
    writeStage(runId, 'page', { status: 'SAFE_STOP', reason, credits: creditsSpent() });
    return { status: 'SAFE_STOP', reason, rounds: 0, open_issues: [], usage: { input_tokens: 0, output_tokens: 0, calls: 0 } };
  }
}

async function buildPageInner(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  const topic = loadTopic(slug);
  const idx = buildIndex();
  const claims = selectClaims(topic, idx.claims.values(), (id) => idx.sources.get(id)?.source_class);
  const usage: Usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  const add = (u: { input_tokens: number; output_tokens: number }, calls = 1) => {
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.calls += calls;
  };
  if (claims.length < MIN_CLAIMS) {
    return { status: 'SAFE_STOP', reason: `INSUFFICIENT_EVIDENCE (${claims.length})`, rounds: 0, open_issues: [], usage };
  }

  // 3) Revisão editorial e gravação: igual para página convergida e para página salva por remoção.
  const finish = async (final: Draft, rounds: number): Promise<PageOutcome> => {
    let draft = final;
    // 3) Revisão editorial: correta não basta, tem de servir. Reprovada fica como rascunho.
    let passed = toPageSpec(draft, topic, runId, 'pass');
    let rv = await reviewPage(passed, topic, fetchImpl);
    add(rv.usage);
    // Quase lá (orienta, tem critérios, enchimento até 45%): corta os blocos que a própria revisão
    // apontou como enchimento e revisa de novo. Remover nunca acrescenta fato; uma vez só.
    const r0 = rv.review;
    if (!r0.publishable && r0.concrete_guidance && r0.answers_primary_query !== 'no' && r0.decision_criteria.length >= loadThresholds().min_criteria && r0.filler_ratio <= 0.45 && r0.filler_refs.length > 0) {
      const trimmed = applyEdits(draft, r0.filler_refs.map((ref) => ({ ref, action: 'remove' as const, reason: 'enchimento apontado pela revisão' }))).draft;
      const candidate = toPageSpec(trimmed, topic, runId, 'pass');
      if (checkPage(candidate, idx).length === 0 && styleIssues(trimmed).length === 0) {
        const rv2 = await reviewPage(candidate, topic, fetchImpl);
        add(rv2.usage);
        writeStage(runId, 'trim', { removed: r0.filler_refs, before: r0, after: rv2.review });
        draft = trimmed;
        passed = candidate;
        rv = rv2;
      }
    }
    const reviewed: PageSpec = { ...passed, provenance: { ...passed.provenance, review: reviewMetrics(rv.review) } };
    const page: PageSpec = rv.review.publishable ? reviewed : { ...reviewed, status: 'draft' };
    writeJson(join(PAGES_DIR, `${slug}.json`), page);
    // A pauta guarda o que faltou: é a entrada da próxima tentativa (improve).
    writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...loadTopic(slug), evidence_gaps: rv.review.publishable ? [] : rv.review.missing }));
    const status = rv.review.publishable ? 'PASS' : 'NOT_PUBLISHABLE';
    writeStage(runId, 'page', { status, rounds: rounds, usage, credits: creditsSpent(), review: rv.review });
    return { status, rounds: rounds, page, usage, review: rv.review };
  };

  const cache: AuditCache = new Map();
  let draft: Draft | null = null;
  let issues: Issue[] = [];
  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    // Primeira rodada e problema de página inteira: reescrita completa. Senão: remendos só nos blocos
    // apontados; o que já foi aprovado fica trancado, então cada rodada só pode reduzir os problemas.
    if (!draft || issues.some((i) => i.ref === null)) {
      const w = await writeDraft(topic, claims, idx.sources, draft ? { previous: draft, issues: issues.map(show) } : null, fetchImpl);
      add(w.usage);
      draft = w.data;
      writeStage(runId, `write-r${round}`, { mode: 'full', draft, issues_in: issues, usage: w.usage, model: w.model });
    } else {
      const p = await writePatches(topic, claims, idx.sources, draft, issues, fetchImpl);
      add(p.usage);
      draft = applyPatches(draft, p.data.patches);
      writeStage(runId, `write-r${round}`, { mode: 'patch', patches: p.data.patches, draft, issues_in: issues, usage: p.usage });
    }

    // 1) Gate determinístico primeiro: é grátis e pega o grosso.
    const gate: Issue[] = checkPage(toPageSpec(draft, topic, runId, 'pending'), idx).map((v) => ({
      ref: refFromWhere(v.where),
      msg: `${v.code} ${v.detail}`,
    }));
    issues = [...gate, ...styleIssues(draft)];
    let findings: AuditFinding[] = [];
    // 2) Auditoria semântica só quando o gate passa (não paga auditor para rascunho quebrado).
    if (issues.length === 0) {
      const a = await auditDraft(draft, idx.claims, idx.sources, fetchImpl, cache);
      add(a.usage, a.usage.calls);
      findings = a.findings;
      issues = findings
        .filter((f) => f.verdict !== 'SUPPORTED')
        .map((f) => ({ ref: f.ref, msg: `${f.verdict}. ${f.problem}${f.fix ? ` Versão sustentável: ${f.fix}` : ''}` }));
    }
    writeStage(runId, `audit-r${round}`, { findings, open_issues: issues });

    if (issues.length === 0) return finish(draft, round + 1);
  }
  // Não convergiu, mas sobraram poucos blocos sem prova: remove esses blocos (remover nunca acrescenta
  // fato) e, se o gate passar, segue para a revisão editorial como qualquer página. Antes, 1 bloco ruim
  // descartava a página inteira depois de 4 rodadas pagas do redator (21/10: 37,8 créditos perdidos).
  if (draft && issues.length > 0 && issues.length <= SALVAGE_MAX && issues.every((i) => i.ref && i.ref !== 'verdict')) {
    const salvaged = applyPatches(draft, issues.map((i) => ({ ref: i.ref!, action: 'remove' as const })));
    const gate = [...checkPage(toPageSpec(salvaged, topic, runId, 'pending'), idx), ...styleIssues(salvaged)];
    if (gate.length === 0 && salvaged.sections.length >= 2) {
      writeStage(runId, 'salvage', { removed: issues.map(show) });
      return finish(salvaged, MAX_FIX_ROUNDS + 1);
    }
  }
  // Não salvou: nada vai para data/pages. O rascunho e os problemas ficam no run para análise.
  const open = issues.map(show);
  writeStage(runId, 'page', { status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', open_issues: open, usage, credits: creditsSpent() });
  return { status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', rounds: MAX_FIX_ROUNDS + 1, open_issues: open, usage };
}
