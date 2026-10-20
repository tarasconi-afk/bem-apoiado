import { z } from 'zod';
import { Basis, Slug, type Claim, type TopicBrief } from '@bem-apoiado/core';

// Schema do rascunho com claim_ids como ENUM FECHADO das evidências desta pauta.
// O redator não consegue citar um id que não recebeu (lição do projeto anterior: atribuição por enum).
export function makeDraftSchema(claimIds: string[]) {
  const Ref = z.enum(claimIds as [string, ...string[]]);
  const Refs = z.array(Ref);
  const Text = z.object({ text: z.string().min(1), basis: Basis, claim_ids: Refs });
  return z.object({
    title: z.string().min(10).max(70),
    description: z.string().min(50).max(160),
    verdict: z.object({ text: z.string().min(20), basis: Basis, claim_ids: Refs }),
    sections: z
      .array(
        z.object({
          id: Slug,
          heading: z.string().min(2),
          blocks: z
            .array(
              z.discriminatedUnion('kind', [
                Text.extend({ kind: z.literal('paragraph') }),
                Text.extend({ kind: z.literal('callout'), tone: z.enum(['info', 'warning']) }),
                z.object({
                  kind: z.literal('table'),
                  caption: z.string(),
                  columns: z.array(z.string()).min(2),
                  rows: z.array(z.object({ cells: z.array(z.object({ text: z.string(), claim_ids: Refs })) })).min(1),
                }),
              ]),
            )
            .min(1),
        }),
      )
      .min(3)
      .max(8),
  });
}
export type Draft = z.infer<ReturnType<typeof makeDraftSchema>>;

// Evidências que podem entrar nesta página: das fontes da pauta e ligadas a perguntas da pauta.
export function claimsForTopic(topic: TopicBrief, all: Iterable<Claim>): Claim[] {
  const qs = new Set(topic.questions.map((q) => q.id));
  const srcs = new Set(topic.source_ids);
  return [...all]
    .filter((c) => srcs.has(c.source_id) && c.question_ids.some((q) => qs.has(q)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Referência estável para cada unidade auditável do rascunho.
export function blockRefs(d: Draft): { ref: string; text: string; claim_ids: string[]; basis: string }[] {
  const out = [{ ref: 'verdict', text: d.verdict.text, claim_ids: d.verdict.claim_ids, basis: d.verdict.basis }];
  for (const s of d.sections) {
    s.blocks.forEach((b, i) => {
      if (b.kind === 'table') {
        b.rows.forEach((r, ri) =>
          out.push({
            ref: `${s.id}#${i}.r${ri}`,
            text: b.columns.map((col, ci) => `${col}: ${r.cells[ci]?.text ?? ''}`).join(' | '),
            claim_ids: [...new Set(r.cells.flatMap((c) => c.claim_ids))],
            basis: 'evidence',
          }),
        );
      } else {
        out.push({ ref: `${s.id}#${i}`, text: b.text, claim_ids: b.claim_ids, basis: b.basis });
      }
    });
  }
  return out;
}
