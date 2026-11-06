import { z } from 'zod';
import { Basis, Slug, type Claim, type TopicBrief } from '@bem-apoiado/core';

// O id da seção é âncora interna (#id), não texto do leitor: um id fora do formato vira slug em vez de derrubar o
// rascunho inteiro. 02/11, lençol solteirão: o redator devolveu sections[0].id fora do padrão duas vezes, a página
// parou (SAFE_STOP) e a pauta foi adiada 3 dias com 19,6 créditos gastos.
export const sectionId = (v: unknown) =>
  typeof v === 'string' ? v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : v;

// A descrição para o Google acima de 160 caracteres é encurtada em vez de derrubar o rascunho inteiro. 06/11, como
// escolher cobertor: o Haiku devolveu a descrição longa duas vezes, a página parou (SAFE_STOP) com 38 evidências e
// 4 regras de escolha prontas, e 25,3 créditos saíram sem página (02/11, solteirão: mesma causa no id da seção).
// Corta no fim da última frase que cabe; sem frase inteira, na última vírgula ou palavra, sem conectivo solto no fim.
// A descrição não cita fonte; o encurtamento só tira texto, e as regras da descrição (número fora do título) seguem.
const MAX_DESC = 160;
const MIN_DESC = 50;
const DANGLING = /\s+(?:e|ou|de|da|do|das|dos|em|no|na|nos|nas|para|por|com|sem|que|a|o|as|os|um|uma|ao|à|se|mas)$/i;
export function fitDescription(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_DESC) return s;
  for (let i = MAX_DESC - 1; i >= MIN_DESC - 1; i--) {
    if (/[.!?]/.test(s.charAt(i)) && s.charAt(i + 1) === ' ') return s.slice(0, i + 1);
  }
  let cut = s.slice(0, MAX_DESC - 1);
  const comma = cut.lastIndexOf(', ');
  cut = comma >= MIN_DESC ? cut.slice(0, comma) : cut.replace(/\s+\S*$/, '');
  for (let prev = ''; prev !== cut; ) { prev = cut; cut = cut.replace(/[\s,;:–—-]+$/, '').replace(DANGLING, ''); }
  return cut.length >= MIN_DESC - 1 ? `${cut}.` : v;
}

// Schema do rascunho com claim_ids como ENUM FECHADO das evidências desta pauta.
// O redator não consegue citar um id que não recebeu (lição do projeto anterior: atribuição por enum).
export function makeDraftSchema(claimIds: string[]) {
  const Ref = z.enum(claimIds as [string, ...string[]]);
  const Refs = z.array(Ref);
  const Text = z.object({ text: z.string().min(1), basis: Basis, claim_ids: Refs });
  return z.object({
    title: z.string().min(10).max(70),
    description: z.preprocess(fitDescription, z.string().min(MIN_DESC).max(MAX_DESC)),
    verdict: z.object({ text: z.string().min(20), basis: Basis, claim_ids: Refs }),
    sections: z
      .array(
        z.object({
          id: z.preprocess(sectionId, Slug),
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
