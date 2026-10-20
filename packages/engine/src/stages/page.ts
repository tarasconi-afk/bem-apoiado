import { join } from 'node:path';
import { checkPage, PageSpec, type TopicBrief } from '@bem-apoiado/core';
import { creditsSpent, LlmError, type FetchLike } from '../llm.ts';
import { MODELS } from '../models.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, writeJson } from '../store.ts';
import { auditDraft, type AuditCache, type AuditFinding } from './audit.ts';
import { blockRefs, claimsForTopic, type Draft } from './draft-schema.ts';
import { applyPatches, refFromWhere, writePatches, type Issue } from './patch.ts';
import { loadTopic } from './research.ts';
import { writeDraft } from './write.ts';

const MAX_FIX_ROUNDS = 3;
const MIN_CLAIMS = 8;

export type PageOutcome =
  | { status: 'PASS'; rounds: number; page: PageSpec; usage: Usage }
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
      writer_model: MODELS.writer.id,
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
  if (draft.title.includes('—')) out.push({ ref: null, msg: 'title: remova o travessão (—).' });
  if (total > 1600) out.push({ ref: null, msg: `página com ${total} palavras; encurte para no máximo 1400, cortando o que não ajuda a decidir.` });
  if (!draft.sections.some((s) => /decidir|escolher/i.test(s.heading))) out.push({ ref: null, msg: 'falta a seção final "Como decidir".' });
  if (draft.sections.length < 3) out.push({ ref: null, msg: 'a página ficou com menos de 3 seções.' });
  return out;
}

const show = (i: Issue) => (i.ref ? `${i.ref}: ${i.msg}` : i.msg);

export async function buildPage(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
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
  const claims = claimsForTopic(topic, idx.claims.values());
  const usage: Usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  const add = (u: { input_tokens: number; output_tokens: number }, calls = 1) => {
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.calls += calls;
  };
  if (claims.length < MIN_CLAIMS) {
    return { status: 'SAFE_STOP', reason: `INSUFFICIENT_EVIDENCE (${claims.length})`, rounds: 0, open_issues: [], usage };
  }

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

    if (issues.length === 0) {
      const page = toPageSpec(draft, topic, runId, 'pass');
      writeJson(join(PAGES_DIR, `${slug}.json`), page);
      writeStage(runId, 'page', { status: 'PASS', rounds: round + 1, usage, credits: creditsSpent() });
      return { status: 'PASS', rounds: round + 1, page, usage };
    }
  }
  // Não convergiu: nada vai para data/pages. O rascunho e os problemas ficam no run para análise.
  const open = issues.map(show);
  writeStage(runId, 'page', { status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', open_issues: open, usage, credits: creditsSpent() });
  return { status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', rounds: MAX_FIX_ROUNDS + 1, open_issues: open, usage };
}
