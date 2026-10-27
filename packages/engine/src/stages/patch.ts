import { z } from 'zod';
import { Basis, type Claim, type Source, type TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import type { Draft } from './draft-schema.ts';
import { formatClaims, writerSystem } from './write.ts';

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

// Colunas de cada linha de tabela a corrigir: o remendo precisa devolver exatamente esse número de células
// (o redator devolvia 3 células numa tabela de 4 colunas e a página não convergia; 21/10).
export function tableColumns(draft: Draft, refs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ref of refs) {
    const m = /^([^#]+)#(\d+)\.r\d+$/.exec(ref);
    const b = m ? draft.sections.find((x) => x.id === m[1])?.blocks[Number(m[2])] : undefined;
    if (b?.kind === 'table') out.set(ref, b.columns);
  }
  return out;
}

// allowRemove=false: conserto de título não pode virar remoção de bloco (27/10: sem alcançar o título, o redator
// apagava o parágrafo e a página perdia evidência que as fontes sustentavam).
export function makePatchSchema(refs: string[], claimIds: string[], columns: Map<string, string[]> = new Map(), allowRemove = true) {
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
      }).superRefine((p, ctx) => {
        // A recusa fica na validação, não no tipo: um enum menor faria o tipo Patch perder "remove" e o
        // typecheck quebraria em quem aplica remendos (27/10, e com ele todo "Aplicar" do painel).
        if (!allowRemove && p.action === 'remove') {
          ctx.addIssue({ code: 'custom', message: `o bloco ${p.ref} não pode ser apagado: o título da seção já está sendo corrigido, mantenha a informação que as fontes sustentam` });
        }
        const cols = columns.get(p.ref);
        if (cols && p.action === 'replace' && p.cells?.length !== cols.length) {
          ctx.addIssue({ code: 'custom', message: `a linha ${p.ref} precisa de exatamente ${cols.length} células, uma por coluna (${cols.join(' | ')}); use "Não informado nas fontes" com claim_ids vazio quando faltar dado` });
        }
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
    } else if (block.kind === 'table' && ri !== undefined && p.cells && p.cells.length === block.columns.length) {
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
  opts: { allowRemove?: boolean } = {},
) {
  const allowRemove = opts.allowRemove ?? true;
  const refs = [...new Set(issues.map((i) => i.ref).filter((r): r is string => r !== null))];
  const columns = tableColumns(draft, refs);
  const schema = makePatchSchema(refs, claims.map((c) => c.id), columns, allowRemove);
  // Contexto enxuto: só as seções com bloco a corrigir (o resto está trancado e não precisa ser relido).
  // Entrada do redator é o maior custo de um remendo; o roteador não faz cache de prompt.
  const touched = new Set(refs.map((r) => r.split('#')[0]));
  const context = {
    title: draft.title,
    ...(touched.has('verdict') ? { verdict: draft.verdict } : {}),
    sections: draft.sections.filter((s) => touched.has(s.id)),
  };
  const user =
    `Pauta: "${topic.primary_query}"\n\nEvidências disponíveis:\n${formatClaims(claims, sources)}\n\n` +
    `Seções do rascunho com blocos a corrigir (só para contexto; os demais blocos já foram aprovados e NÃO podem mudar):\n${JSON.stringify(context)}\n\n` +
    `Corrija apenas estes blocos. Para cada ref, devolva um remendo: "replace" com o novo texto, basis e claim_ids ` +
    (allowRemove
      ? `(ou "cells" para linha de tabela), ou "remove" se o bloco não se sustenta nem estreitado.\n`
      : `(ou "cells" para linha de tabela). O título da seção já está sendo corrigido à parte: NÃO apague o bloco; mantenha a informação que as fontes sustentam.\n`) +
    issues.filter((i) => i.ref).map((i) => `- ${i.ref}: ${i.msg}${columns.has(i.ref!) ? ` [linha de tabela: exatamente ${columns.get(i.ref!)!.length} células, colunas ${columns.get(i.ref!)!.join(' | ')}]` : ''}`).join('\n');
  return callJson({ role: 'writer', system: writerSystem(), user, schema, schemaName: 'page_patches', maxTokens: 8000 }, fetchImpl);
}
