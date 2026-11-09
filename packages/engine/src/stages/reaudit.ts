import { join } from 'node:path';
import { checkPage, PageSpec } from '@bem-apoiado/core';
import { creditsSpent, LlmError, type FetchLike } from '../llm.ts';
import { MODELS } from '../models.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, writeJson } from '../store.ts';
import { auditDraft, type AuditCache } from './audit.ts';
import { claimsForTopic, type Draft } from './draft-schema.ts';
import { styleIssues } from './page.ts';
import { applyPatches, refFromWhere, writePatches, type Issue, type Patch } from './patch.ts';
import { loadTopic } from './research.ts';
import { keepsReaderValue, reviewPage } from './review.ts';
import { decisionMarkers } from './requests.ts';

// Re-auditoria de página já publicada: o auditor atual relê tudo; o que ele apontar ganha remendo só
// naquele bloco e é auditado de novo. Converge: grava a página (vai para o ramo do ciclo e espera o
// aceite humano, porque mexe em página no ar). Não converge: a página publicada fica como está e os
// problemas ficam no registro da execução.
const MAX_ROUNDS = 2;

export type ReauditOutcome =
  | { status: 'CLEAN'; slug: string }
  | { status: 'FIXED'; slug: string; fixed: string[] }
  | { status: 'OPEN'; slug: string; open: Issue[] }
  | { status: 'WORSE'; slug: string; before: number; after: number }
  | { status: 'SAFE_STOP'; slug: string; reason: string };

export async function reauditPage(page: PageSpec, runId: string, fetchImpl?: FetchLike, now = new Date()): Promise<ReauditOutcome> {
  try {
    const topic = loadTopic(page.slug);
    const idx = buildIndex();
    const claims = claimsForTopic(topic, idx.claims.values());
    const cache: AuditCache = new Map();
    let draft: Draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections };
    const first = await auditDraft(draft, idx.claims, idx.sources, fetchImpl, cache);
    // A versão sustentável que o auditor propõe para cada bloco (a mais recente vale: refere-se ao texto atual).
    const fixes = new Map<string, string>();
    const toIssues = (fs: typeof first.findings): Issue[] => fs.filter((f) => f.verdict !== 'SUPPORTED').map((f) => {
      if (f.fix?.trim()) fixes.set(f.ref, f.fix.trim());
      return { ref: f.ref, msg: `${f.verdict}. ${f.problem}${f.fix ? ` Versão sustentável: ${f.fix}` : ''}` };
    });
    let issues: Issue[] = toIssues(first.findings);
    writeStage(runId, `reaudit-${page.slug}-r0`, { model: MODELS.auditor.id, findings: first.findings });
    if (issues.length === 0) return { status: 'CLEAN', slug: page.slug };
    const fixed = issues.map((i) => i.ref!).filter(Boolean);

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const p = await writePatches(topic, claims, idx.sources, draft, issues, fetchImpl);
      const patched = applyPatches(draft, p.data.patches);
      const spec = { ...page, ...patched };
      const gate: Issue[] = [...checkPage(spec, idx).map((v) => ({ ref: refFromWhere(v.where), msg: `${v.code} ${v.detail}` })), ...styleIssues(patched)];
      const touched = new Set(issues.map((i) => i.ref).filter((r): r is string => !!r));
      const a = gate.length ? null : await auditDraft(patched, idx.claims, idx.sources, fetchImpl, cache, touched);
      draft = patched;
      // A versão sustentável do auditor ia só na 1ª rodada; nas seguintes o redator trabalhava sem ela.
      issues = gate.length ? gate : toIssues(a!.findings);
      writeStage(runId, `reaudit-${page.slug}-r${round}`, { patches: p.data.patches, open_issues: issues });
      if (issues.length === 0) return await accept(draft);
    }
    // 09/11, travesseiro de látex ou viscoelástico: nas 2 rodadas o redator manteve "a Duoflex descreve isso em
    // seus modelos viscoelásticos", que o trecho não diz, e a página seguiu no ar com a atribuição errada. O auditor
    // tinha escrito a versão sustentável desde a 1ª leitura. Último recurso, sem redator: usar o texto do próprio
    // auditor no bloco, com as mesmas evidências; só vale se o gate e a auditoria daquele bloco passarem e a
    // revisão não piorar (accept mede isso).
    const fallback = auditorFixPatches(draft, issues, fixes);
    if (fallback) {
      const patched = applyPatches(draft, fallback);
      const gate: Issue[] = [...checkPage({ ...page, ...patched }, idx).map((v) => ({ ref: refFromWhere(v.where), msg: `${v.code} ${v.detail}` })), ...styleIssues(patched)];
      const touched = new Set(fallback.map((p) => p.ref));
      const a = gate.length ? null : await auditDraft(patched, idx.claims, idx.sources, fetchImpl, cache, touched);
      const left = gate.length ? gate : a!.findings.filter((f) => f.verdict !== 'SUPPORTED').map((f) => ({ ref: f.ref, msg: `${f.verdict}. ${f.problem}` }));
      writeStage(runId, `reaudit-${page.slug}-versao-do-auditor`, { patches: fallback, open_issues: left });
      if (left.length === 0) return await accept(patched);
    }
    return { status: 'OPEN', slug: page.slug, open: issues };

    async function accept(draft: Draft): Promise<ReauditOutcome> {
      const updated: PageSpec = PageSpec.parse({
        ...page, ...draft, updated_at: now.toISOString().slice(0, 10),
        provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+reaudit:${runId}`, auditor_model: MODELS.auditor.id, audit_verdict: 'pass' },
      });
      // 29/10, lençol com elástico: a re-auditoria semanal corrigiu 14 blocos no dia seguinte à aprovação e a
      // página saiu mais exata e menos útil — a resposta curta foi de "procure um lençol com medidas iguais ou
      // maiores, e profundidade que cubra a altura do colchão" para "compare as medidas informadas com as do
      // colchão". O ajuste pelo painel já media isso e revertia (requests.ts); a re-auditoria não media nada.
      // A mesma régua, inclusive a tolerância: pode cair meio ponto se o texto ficou mais honesto, mas a
      // resposta curta tem de continuar mandando escolher.
      const [after, before] = await Promise.all([reviewPage(updated, topic, fetchImpl), reviewPage(page, topic, fetchImpl)]);
      const v = keepsReaderValue(before.review, after.review, decisionMarkers(page.verdict.text), decisionMarkers(updated.verdict.text));
      writeStage(runId, `reaudit-${page.slug}-revisao`, { score_before: v.before, score_after: v.after, kept: v.ok, before: before.review, after: after.review });
      if (!v.ok) return { status: 'WORSE', slug: page.slug, before: v.before, after: v.after };
      writeJson(join(PAGES_DIR, `${page.slug}.json`), updated);
      return { status: 'FIXED', slug: page.slug, fixed };
    }
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    return { status: 'SAFE_STOP', slug: page.slug, reason: `LLM_${e.code}: ${e.message.slice(0, 200)} (~${creditsSpent().toFixed(1)} créditos)` };
  }
}

// Remendo com a versão sustentável do auditor para cada problema que sobrou; null se algum não tiver versão
// ou cair em tabela, título, descrição ou veredito (só parágrafo e destaque, com as evidências que já tinham).
export function auditorFixPatches(draft: Draft, issues: Issue[], fixes: Map<string, string>): Patch[] | null {
  if (!issues.length) return null;
  const out: Patch[] = [];
  for (const i of issues) {
    const m = i.ref ? /^([^#]+)#(\d+)$/.exec(i.ref) : null;
    const text = i.ref ? fixes.get(i.ref) : undefined;
    const block = m ? draft.sections.find((s) => s.id === m[1])?.blocks[Number(m[2])] : undefined;
    if (!m || !text || !block || block.kind === 'table' || !('claim_ids' in block) || !block.claim_ids?.length) return null;
    out.push({ ref: i.ref!, action: 'replace', text, claim_ids: block.claim_ids } as Patch);
  }
  return out;
}

// Qual página re-auditar: a publicada que nunca passou pelo auditor atual ou cuja última re-auditoria
// tem mais de 30 dias. Uma por ciclo.
export function nextReaudit(pages: PageSpec[], last: Record<string, { at: string; model: string }>, now = new Date()): PageSpec | undefined {
  const due = (p: PageSpec) => {
    const l = last[p.slug];
    return !l || l.model !== MODELS.auditor.id || now.getTime() - Date.parse(l.at) > 30 * 86_400_000;
  };
  return pages.filter((p) => p.status !== 'draft' && due(p)).sort((a, b) => a.updated_at.localeCompare(b.updated_at))[0];
}
