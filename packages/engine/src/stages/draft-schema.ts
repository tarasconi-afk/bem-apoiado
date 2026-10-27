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

// Evidências citadas pelas regras de decisão da checagem antes da redação (nota "Regra de decisão sustentada: …
// (evidências: clm_…)"): entram sempre, são o dado que decide.
export function ruleClaimIds(topic: Pick<TopicBrief, 'editorial_notes'>): Set<string> {
  const out = new Set<string>();
  for (const n of topic.editorial_notes ?? []) for (const m of n.matchAll(/clm_[a-f0-9]{12}/g)) out.add(m[0]);
  return out;
}

export function selectClaims(topic: TopicBrief, all: Iterable<Claim>, classOf: (sourceId: string) => string | undefined, keep: Set<string> = new Set(), max = WRITER_MAX_CLAIMS): Claim[] {
  const pool = claimsForTopic(topic, all);
  if (pool.length <= max) return pool;
  const qs = topic.questions.map((q) => q.id);
  const qset = new Set(qs);
  const focus = topic.focus_terms.map((t) => t.toLowerCase());
  const weight: Record<string, number> = { regulator: 2, standard_body: 2, independent_test: 1.5, manufacturer: 1 };
  // Guia da marca ou norma vale mais que a ficha de um produto: fala do tamanho ou do tipo, não de um modelo.
  const scopeBonus = (c: Claim) => (c.scope === 'marca' || c.scope === 'geral' ? 1.5 : 0);
  const score = (c: Claim) => c.question_ids.filter((q) => qset.has(q)).length * 2 + (weight[classOf(c.source_id) ?? ''] ?? 0.5) + focus.filter((f) => c.quote.toLowerCase().includes(f)).length * 0.5 + scopeBonus(c);
  const must = new Set([...keep, ...ruleClaimIds(topic)]);
  const kept = pool.filter((c) => must.has(c.id));
  // Fichas de produto repetem o mesmo número dezenas de vezes ("viúva X mede 128 × 188", "viúva Y mede 128 × 188"):
  // no máximo 2 por (fonte-mãe, tipo, números), o bastante para "nos modelos citados de X e Y". Sem número não deduplica.
  const dupKey = (c: Claim) => { const nums = [...new Set((c.statement ?? '').match(/\d+(?:[.,]\d+)?/g) ?? [])].sort().join(','); return nums ? `${classOf(c.source_id) ?? ''}|${c.claim_type}|${nums}` : null; };
  const seen = new Map<string, number>();
  const rest = pool.filter((c) => !must.has(c.id)).sort((a, b) => score(b) - score(a)).filter((c) => { const k = dupKey(c); if (!k) return true; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return n < 2; });
  // 1) Uma vaga por fonte (variedade de fabricantes). 2) Revezamento por pergunta, pela pontuação dentro de cada
  // uma: 27/10, o solteirão tinha 112 evidências para 60 vagas e as que decidiam (medidas do guia da Castor)
  // ficaram de fora enquanto garantia e itens inclusos entravam, porque a pontuação não olha de qual pergunta é.
  const bySource = new Set<string>();
  const first = rest.filter((c) => (bySource.has(c.source_id) ? false : (bySource.add(c.source_id), true)));
  const chosen = new Set<Claim>([...kept, ...first]);
  const limit = Math.max(max, kept.length);
  const queues = qs.map((q) => rest.filter((c) => !chosen.has(c) && c.question_ids.includes(q)));
  for (let i = 0; chosen.size < limit && queues.some((l) => l.length); i = (i + 1) % queues.length) {
    const c = queues[i]!.shift();
    if (c && !chosen.has(c)) chosen.add(c);
  }
  return [...chosen].slice(0, limit).sort((a, b) => a.id.localeCompare(b.id));
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
