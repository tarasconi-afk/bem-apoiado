import { join } from 'node:path';
import { z } from 'zod';
import { checkPage, type PageSpec } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, writeJson } from '../store.ts';
import { auditDraft } from './audit.ts';
import { blockRefs, type Draft } from './draft-schema.ts';
import { formatClaims } from './write.ts';
import { styleIssues } from './page.ts';

// Editor: só corta, encurta ou junta blocos de uma página JÁ aprovada. Nunca acrescenta fato:
// o texto reescrito só pode citar evidências que já estavam nos blocos que ele substitui.

const SYSTEM = `Você é o editor do site Bem Apoiado. A página abaixo já foi aprovada pela auditoria de evidências.
Seu trabalho é deixá-la mais enxuta para um leitor leigo, sem acrescentar nenhuma informação.

Operações permitidas, por ref de bloco:
- "remove": apagar um bloco repetido ou que não ajuda a decidir.
- "rewrite": reescrever um bloco mais curto ou mais claro. Use "absorbs" para juntar nele outros blocos
  que dizem a mesma coisa (eles serão apagados). "claim_ids" só pode conter ids que já estavam no bloco
  reescrito ou nos blocos absorvidos.

Proibido: fato novo, número novo, atribuição nova, mudar o sentido. Não mexa no que já está bom.
Priorize: repetições entre seções, frases vagas de fabricante, parágrafos longos.
Mantenha a seção "Como decidir" e pelo menos um bloco em cada seção.
Não use travessão (—). Se nada precisa mudar, devolva "edits": [].`;

export function makeEditSchema(refs: string[], claimIds: string[]) {
  const Ref = z.enum(refs as [string, ...string[]]);
  return z.object({
    edits: z
      .array(
        z.object({
          ref: Ref,
          action: z.enum(['remove', 'rewrite']),
          text: z.string().optional(),
          claim_ids: z.array(z.enum(claimIds as [string, ...string[]])).optional(),
          absorbs: z.array(Ref).optional(),
          reason: z.string(),
        }),
      )
      .max(15),
  });
}
type Edit = z.infer<ReturnType<typeof makeEditSchema>>['edits'][number];

// Aplica as edições respeitando a regra de não acrescentar evidência. Devolve também o que foi recusado.
export function applyEdits(draft: Draft, edits: Edit[]): { draft: Draft; changed: string[]; refused: string[] } {
  const d: Draft = structuredClone(draft);
  const units = new Map(blockRefs(draft).map((u) => [u.ref, u]));
  const toRemove = new Set<string>();
  const changed: string[] = [];
  const refused: string[] = [];
  const locate = (ref: string) => {
    const m = /^([^#]+)#(\d+)$/.exec(ref);
    if (!m) return null;
    const block = d.sections.find((s) => s.id === m[1])?.blocks[Number(m[2])];
    return block && block.kind !== 'table' ? block : null;
  };

  for (const e of edits) {
    if (e.action === 'remove') {
      if (e.ref === 'verdict') refused.push(`${e.ref}: o veredito não pode ser removido`);
      else toRemove.add(e.ref);
      continue;
    }
    const allowed = new Set([e.ref, ...(e.absorbs ?? [])].flatMap((r) => units.get(r)?.claim_ids ?? []));
    const ids = e.claim_ids ?? [];
    if (!e.text || ids.some((id) => !allowed.has(id))) {
      refused.push(`${e.ref}: reescrita sem texto ou citando evidência que o bloco não tinha`);
      continue;
    }
    if (e.ref === 'verdict') {
      d.verdict = { ...d.verdict, text: e.text, claim_ids: ids };
    } else {
      const b = locate(e.ref);
      if (!b) {
        refused.push(`${e.ref}: só parágrafos e avisos podem ser reescritos`);
        continue;
      }
      b.text = e.text;
      b.claim_ids = ids;
    }
    changed.push(e.ref);
    (e.absorbs ?? []).forEach((r) => r !== e.ref && toRemove.add(r));
  }
  // Remoção do fim para o começo, para os índices não mudarem no meio.
  [...toRemove]
    .map((r) => /^([^#]+)#(\d+)/.exec(r))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[2]) - Number(a[2]))
    .forEach((m) => {
      const s = d.sections.find((x) => x.id === m[1]);
      if (s && s.blocks.length > 1) s.blocks.splice(Number(m[2]), 1);
      else refused.push(`${m[0]}: a seção ficaria vazia`);
    });
  return { draft: d, changed, refused };
}

export type EditOutcome =
  | { status: 'EDITED'; removed: number; rewritten: number; wordsBefore: number; wordsAfter: number; refused: string[] }
  | { status: 'UNCHANGED' | 'REVERTED'; reason: string; refused: string[] };

const words = (d: Draft) => blockRefs(d).reduce((t, u) => t + u.text.split(/\s+/).filter(Boolean).length, 0);

export async function editPage(page: PageSpec, runId: string, fetchImpl?: FetchLike): Promise<EditOutcome> {
  const idx = buildIndex();
  const draft: Draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections };
  const refs = blockRefs(draft).map((u) => u.ref);
  const cited = [...new Set(blockRefs(draft).flatMap((u) => u.claim_ids))];
  const claims = cited.map((id) => idx.claims.get(id)!).filter(Boolean);

  const r = await callJson(
    {
      role: 'writer',
      system: SYSTEM,
      user: `Evidências citadas na página:\n${formatClaims(claims, idx.sources)}\n\nPágina (refs dos blocos entre colchetes):\n` +
        blockRefs(draft).map((u) => `[${u.ref}] (${u.basis}) ${u.text}`).join('\n'),
      schema: makeEditSchema(refs, cited),
      schemaName: 'page_edits',
      maxTokens: 6000,
    },
    fetchImpl,
  );
  const { draft: edited, changed, refused } = applyEdits(draft, r.data.edits);
  writeStage(runId, 'edit-proposal', { edits: r.data.edits, refused, usage: r.usage });
  if (r.data.edits.length === 0 || (changed.length === 0 && blockRefs(edited).length === refs.length)) {
    return { status: 'UNCHANGED', reason: 'editor não propôs mudança aplicável', refused };
  }

  // Blocos alterados identificados pelo CONTEÚDO (remoções mudam a posição dos demais).
  const key = (u: { text: string; claim_ids: string[] }) => JSON.stringify([u.text, [...u.claim_ids].sort()]);
  const original = new Set(blockRefs(draft).map(key));
  const changedUnits = blockRefs(edited).filter((u) => !original.has(key(u)));

  // Auditoria só dos blocos reescritos. Reescrita reprovada é descartada sozinha (a edição que a
  // gerou sai da lista, inclusive o que ela absorvia); as aprovadas ficam.
  let accepted = r.data.edits;
  let rejectedEdits: string[] = [];
  if (changedUnits.length > 0) {
    const a = await auditDraft(edited, idx.claims, idx.sources, fetchImpl, new Map(), new Set(changedUnits.map((u) => u.ref)));
    const bad = new Set(a.findings.filter((f) => f.verdict !== 'SUPPORTED').map((f) => changedUnits.find((u) => u.ref === f.ref)?.text));
    rejectedEdits = a.findings.filter((f) => f.verdict !== 'SUPPORTED').map((f) => `${f.ref}: ${f.verdict} ${f.problem}`);
    accepted = r.data.edits.filter((e) => !(e.action === 'rewrite' && bad.has(e.text)));
  }
  const final = applyEdits(draft, accepted).draft;
  const candidate: PageSpec = { ...page, ...final };
  const gate = [...checkPage(candidate, idx).map((v) => `${v.where}: ${v.code}`), ...styleIssues(final).map((i) => i.msg)];
  writeStage(runId, 'edit-audit', { changed: changedUnits.map((u) => u.ref), rejected: rejectedEdits, gate, accepted: accepted.length, credits: creditsSpent() });
  if (gate.length > 0) return { status: 'REVERTED', reason: `gate: ${gate.join(' | ').slice(0, 400)}`, refused };
  if (accepted.length === 0) return { status: 'REVERTED', reason: rejectedEdits.join(' | ').slice(0, 400), refused };
  const edited2 = final;

  const updated: PageSpec = { ...candidate, updated_at: new Date().toISOString().slice(0, 10), provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+edit:${runId}` } };
  writeJson(join(PAGES_DIR, `${page.slug}.json`), updated);
  return {
    status: 'EDITED',
    removed: refs.length - blockRefs(edited2).length,
    rewritten: accepted.filter((e) => e.action === 'rewrite').length,
    wordsBefore: words(draft),
    wordsAfter: words(edited2),
    refused: [...refused, ...rejectedEdits],
  };
}

