import { join } from 'node:path';
import { checkPage, PageSpec } from '@bem-apoiado/core';
import type { FetchLike } from '../llm.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, writeJson } from '../store.ts';
import { auditDraft } from './audit.ts';
import { blockRefs, type Draft } from './draft-schema.ts';
import { styleIssues } from './page.ts';

// Edição manual pelo painel: o editor muda o TEXTO de blocos (resposta curta, parágrafos, avisos); as
// fontes citadas de cada bloco ficam como estão. A regra vale para o editor também: o bloco alterado passa
// pelo gate e pelo auditor; só grava se todos os alterados forem SUSTENTADOS. Tabela fica fora (v1).

export type ManualEditOutcome =
  | { status: 'SAVED'; changed: string[] }
  | { status: 'UNCHANGED' }
  | { status: 'REJECTED'; problems: { ref: string; msg: string }[] };

export function applyTextEdits(d: Draft, edits: Record<string, string>): { draft: Draft; changed: string[] } {
  const draft: Draft = structuredClone(d);
  const changed: string[] = [];
  for (const [ref, raw] of Object.entries(edits)) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (ref === 'verdict') {
      if (text && text !== draft.verdict.text) (draft.verdict.text = text), changed.push(ref);
      continue;
    }
    const m = /^([^#]+)#(\d+)$/.exec(ref);
    const b = m ? draft.sections.find((s) => s.id === m[1])?.blocks[Number(m[2])] : undefined;
    if (!b || b.kind === 'table' || !text || text === b.text) continue;
    b.text = text;
    changed.push(ref);
  }
  return { draft, changed };
}

export async function manualEdit(page: PageSpec, edits: Record<string, string>, runId: string, fetchImpl?: FetchLike, now = new Date()): Promise<ManualEditOutcome> {
  const base: Draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections };
  const { draft, changed } = applyTextEdits(base, edits);
  if (!changed.length) return { status: 'UNCHANGED' };
  const idx = buildIndex();
  const spec = PageSpec.parse({ ...page, ...draft });
  const touched = new Set(changed);
  const gate = [
    ...checkPage(spec, idx).map((v) => ({ ref: v.where, msg: `${v.code} ${v.detail}` })),
    ...styleIssues(draft).filter((i) => i.ref && touched.has(i.ref)).map((i) => ({ ref: i.ref!, msg: i.msg })),
  ];
  if (gate.length) return { status: 'REJECTED', problems: gate };
  const a = await auditDraft(draft, idx.claims, idx.sources, fetchImpl, new Map(), touched);
  writeStage(runId, 'manual-edit', { slug: page.slug, changed, findings: a.findings });
  const bad = a.findings.filter((f) => f.verdict !== 'SUPPORTED');
  if (bad.length) return { status: 'REJECTED', problems: bad.map((f) => ({ ref: f.ref, msg: `${f.verdict}: ${f.problem}${f.fix ? ` Versão que as fontes sustentam: "${f.fix}"` : ''}` })) };
  writeJson(join(PAGES_DIR, `${page.slug}.json`), PageSpec.parse({
    ...spec, updated_at: now.toISOString().slice(0, 10),
    provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+editor:${runId}` },
  }));
  return { status: 'SAVED', changed };
}

// Blocos editáveis (para o formulário do painel), com as fontes citadas de cada um.
export function editableBlocks(page: PageSpec): { ref: string; label: string; text: string; claim_ids: string[] }[] {
  const d: Draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections };
  const heading = new Map(page.sections.map((s) => [s.id, s.heading]));
  return blockRefs(d)
    .filter((u) => !u.ref.includes('.r'))
    .map((u) => ({ ref: u.ref, label: u.ref === 'verdict' ? 'Resposta curta' : `${heading.get(u.ref.split('#')[0]!) ?? ''} · bloco ${Number(u.ref.split('#')[1]) + 1}`, text: u.text, claim_ids: u.claim_ids }));
}
