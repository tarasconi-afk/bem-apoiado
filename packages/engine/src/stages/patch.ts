import { z } from 'zod';
import { Basis, type Claim, type Source, type TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import type { Draft } from './draft-schema.ts';
import { formatClaims, WRITER_SYSTEM } from './write.ts';

export interface Issue {
  ref: string | null; // null = problema da página inteira (exige reescrita completa)
  msg: string;
}

// Converte o "where" do gate determinístico para a ref de bloco usada na auditoria.
export function refFromWhere(where: string): string | null {
  if (where === 'verdict') return 'verdict';
  const m = /^section:([^#]+)#(\d+)(?:\.r(\d+)(?:c\d+)?|\.row(\d+))?/.exec(where);
  if (!m) return null;
  const row = m[3] ?? m[4];
  return row !== undefined ? `${m[1]}#${m[2]}.r${row}` : `${m[1]}#${m[2]}`;
}

export function makePatchSchema(refs: string[], claimIds: string[]) {
  const Refs = z.array(z.enum(claimIds as [string, ...string[]]));
  return z.object({
    patches: z.array(
      z.object({
        ref: z.enum(refs as [string, ...string[]]),
        action: z.enum(['replace', 'remove']),
        // replace de parágrafo, callout ou veredito
        text: z.string().optional(),
        basis: Basis.optional(),
        claim_ids: Refs.optional(),
        // replace de linha de tabela
        cells: z.array(z.object({ text: z.string(), claim_ids: Refs })).optional(),
      }),
    ),
  });
}
export type Patch = z.infer<ReturnType<typeof makePatchSchema>>['patches'][number];

// Aplica remendos sem tocar em nenhum outro bloco. Remoções são feitas do fim para o começo.
export function applyPatches(draft: Draft, patches: Patch[]): Draft {
  const d: Draft = structuredClone(draft);
  const removals: { sec: string; block: number; row?: number }[] = [];
  for (const p of patches) {
    if (p.ref === 'verdict') {
      if (p.action === 'replace' && p.text) d.verdict = { text: p.text, basis: p.basis ?? d.verdict.basis, claim_ids: p.claim_ids ?? [] };
      continue;
    }
    const m = /^([^#]+)#(\d+)(?:\.r(\d+))?$/.exec(p.ref);
    if (!m) continue;
    const [sec, bi, ri] = [m[1]!, Number(m[2]), m[3] !== undefined ? Number(m[3]) : undefined];
    const block = d.sections.find((s) => s.id === sec)?.blocks[bi];
    if (!block) continue;
    if (p.action === 'remove') {
      removals.push({ sec, block: bi, ...(ri !== undefined ? { row: ri } : {}) });
    } else if (block.kind === 'table' && ri !== undefined && p.cells) {
      block.rows[ri] = { cells: p.cells };
    } else if (block.kind !== 'table' && p.text) {
      block.text = p.text;
      block.basis = p.basis ?? block.basis;
      block.claim_ids = p.claim_ids ?? [];
    }
  }
  removals
    .sort((a, b) => b.block - a.block || (b.row ?? -1) - (a.row ?? -1))
    .forEach((r) => {
      const s = d.sections.find((x) => x.id === r.sec)!;
      const b = s.blocks[r.block];
      if (r.row !== undefined && b?.kind === 'table') b.rows.splice(r.row, 1);
      else s.blocks.splice(r.block, 1);
    });
  // Tabela sem linha e seção sem bloco deixam de existir.
  d.sections.forEach((s) => (s.blocks = s.blocks.filter((b) => b.kind !== 'table' || b.rows.length > 0)));
  d.sections = d.sections.filter((s) => s.blocks.length > 0);
  return d;
}

export async function writePatches(
  topic: TopicBrief,
  claims: Claim[],
  sources: Map<string, Source>,
  draft: Draft,
  issues: Issue[],
  fetchImpl?: FetchLike,
) {
  const refs = [...new Set(issues.map((i) => i.ref).filter((r): r is string => r !== null))];
  const schema = makePatchSchema(refs, claims.map((c) => c.id));
  const user =
    `Pauta: "${topic.primary_query}"\n\nEvidências disponíveis:\n${formatClaims(claims, sources)}\n\n` +
    `Rascunho atual (só para contexto; os demais blocos já foram aprovados e NÃO podem mudar):\n${JSON.stringify(draft)}\n\n` +
    `Corrija apenas estes blocos. Para cada ref, devolva um remendo: "replace" com o novo texto, basis e claim_ids ` +
    `(ou "cells" para linha de tabela), ou "remove" se o bloco não se sustenta nem estreitado.\n` +
    issues.filter((i) => i.ref).map((i) => `- ${i.ref}: ${i.msg}`).join('\n');
  return callJson({ role: 'writer', system: WRITER_SYSTEM, user, schema, schemaName: 'page_patches', maxTokens: 8000 }, fetchImpl);
}
