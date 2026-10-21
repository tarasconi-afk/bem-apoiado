import { join } from 'node:path';
import { z } from 'zod';
import { Claim, TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { CLAIMS_DIR, loadClaims, loadTopics, TOPICS_DIR, writeJson } from '../store.ts';
import { loadTopic } from './research.ts';

// Reuso de evidências: a base cresce a cada página. Uma pauta nova aproveita evidências já verificadas de
// pautas com os mesmos tipos de produto (ou da mesma categoria do nicho): o trecho literal já foi conferido
// contra a fonte; o modelo barato só diz a que pergunta da pauta nova cada uma responde. A pesquisa nova
// vai atrás só do que faltar. 21/10: "como escolher colchão" foi reprovada sem densidade, Inmetro e
// etiqueta, que o motor já tinha verificado para outras páginas.

const MAX_CANDIDATES = 140;

const Mapping = z.object({ links: z.array(z.object({ claim_id: z.string(), question_ids: z.array(z.string()) })) });

export function siblingClaims(topic: TopicBrief, topics: TopicBrief[], claims: Claim[]): Claim[] {
  const cats = loadNiche().categories;
  const catOf = (kinds: string[]) => new Set(cats.filter((c) => c.kinds.some((k) => kinds.includes(k))).map((c) => c.id));
  const mine = new Set(topic.product_kinds);
  const myCats = catOf(topic.product_kinds);
  const siblings = topics.filter((t) => t.slug !== topic.slug && (t.product_kinds.some((k) => mine.has(k)) || [...catOf(t.product_kinds)].some((c) => myCats.has(c))));
  const srcs = new Set(siblings.flatMap((t) => t.source_ids));
  const own = new Set(topic.source_ids);
  return claims.filter((c) => srcs.has(c.source_id) && !own.has(c.source_id) && c.claim_type !== 'availability').slice(0, MAX_CANDIDATES);
}

export async function reuseEvidence(slug: string, fetchImpl?: FetchLike): Promise<{ reused: number; sources: number }> {
  const topic = loadTopic(slug);
  const all = loadClaims();
  const candidates = siblingClaims(topic, loadTopics(), all);
  if (!candidates.length) return { reused: 0, sources: 0 };
  const qids = topic.questions.map((q) => q.id) as [string, ...string[]];
  const ids = candidates.map((c) => c.id) as [string, ...string[]];
  const Out = z.object({ links: z.array(z.object({ claim_id: z.enum(ids), question_ids: z.array(z.enum(qids)) })) });
  const r = await callJson(
    {
      role: 'extractor',
      system:
        'Você liga evidências já verificadas às perguntas de uma pauta nova. Para cada evidência que responde DIRETAMENTE a uma ou mais perguntas, devolva o id e as perguntas. Ignore a evidência que só tangencia o tema. Não invente ids.',
      user:
        `Pauta: "${topic.primary_query}"\nPerguntas:\n${topic.questions.map((q) => `- ${q.id}: ${q.text}`).join('\n')}\n\nEvidências:\n` +
        candidates.map((c) => `- ${c.id}: ${c.statement} | trecho: "${c.quote.slice(0, 160)}"`).join('\n'),
      schema: Out,
      schemaName: 'evidence_reuse',
      maxTokens: 4000,
    },
    fetchImpl,
  );
  Mapping.parse(r.data);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const newSources = new Set<string>();
  let reused = 0;
  for (const l of r.data.links) {
    const c = byId.get(l.claim_id);
    if (!c || !l.question_ids.length) continue;
    const merged = [...new Set([...c.question_ids, ...l.question_ids])];
    if (merged.length === c.question_ids.length) continue;
    writeJson(join(CLAIMS_DIR, `${c.id}.json`), Claim.parse({ ...c, question_ids: merged }));
    newSources.add(c.source_id);
    reused++;
  }
  if (newSources.size) {
    // Fonte reaproveitada entra como já pesquisada: a pesquisa nova não relê o que já foi extraído.
    writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({
      ...topic,
      source_ids: [...new Set([...topic.source_ids, ...newSources])],
      researched_source_ids: [...new Set([...topic.researched_source_ids, ...newSources])],
    }));
  }
  return { reused, sources: newSources.size };
}
