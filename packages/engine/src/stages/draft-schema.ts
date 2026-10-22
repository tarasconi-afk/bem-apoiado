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

// Evidências que o redator recebe: as mais ligadas às perguntas da pauta, no máximo `max` (21/10: a base box
// mandou 91 evidências, o Haiku estourou o tempo do roteador duas vezes e a reserva cara entrou). Regulador e
// norma pesam mais; as já citadas na página (`keep`) entram sempre.
export const WRITER_MAX_CLAIMS = 60;
export function selectClaims(topic: TopicBrief, all: Iterable<Claim>, classOf: (sourceId: string) => string | undefined, keep: Set<string> = new Set(), max = WRITER_MAX_CLAIMS): Claim[] {
  const pool = claimsForTopic(topic, all);
  if (pool.length <= max) return pool;
  const qs = new Set(topic.questions.map((q) => q.id));
  const focus = topic.focus_terms.map((t) => t.toLowerCase());
  const weight: Record<string, number> = { regulator: 2, standard_body: 2, independent_test: 1.5, manufacturer: 1 };
  const score = (c: Claim) => c.question_ids.filter((q) => qs.has(q)).length * 2 + (weight[classOf(c.source_id) ?? ''] ?? 0.5) + focus.filter((f) => c.quote.toLowerCase().includes(f)).length * 0.5;
  const kept = pool.filter((c) => keep.has(c.id));
  // Uma vaga por fonte primeiro (variedade de fabricantes), depois pela pontuação.
  const rest = pool.filter((c) => !keep.has(c.id)).sort((a, b) => score(b) - score(a));
  const bySource = new Set<string>();
  const first = rest.filter((c) => (bySource.has(c.source_id) ? false : (bySource.add(c.source_id), true)));
  const chosen = [...kept, ...first, ...rest.filter((c) => !first.includes(c))].slice(0, Math.max(max, kept.length));
  return chosen.sort((a, b) => a.id.localeCompare(b.id));
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
            // O título da tabela vai junto de cada linha: é nele que fica de quem são os dados ("Densidade indicada
            // pela Castor"); sem ele o auditor via a linha solta e a tratava como regra geral (22/10).
            text: `[tabela: ${b.caption}] ` + b.columns.map((col, ci) => `${col}: ${r.cells[ci]?.text ?? ''}`).join(' | '),
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
