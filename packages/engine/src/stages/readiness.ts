import { join } from 'node:path';
import { z } from 'zod';
import { TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, TOPICS_DIR, writeJson } from '../store.ts';
import { selectClaims } from './draft-schema.ts';
import { formatClaims } from './write.ts';

// Checagem antes da redação (22/10): só escreve quando as evidências permitem dizer ao leitor o que escolher.
// "Colchão misto ou de espuma" foi escrita com a densidade por peso, que não diferencia misto de espuma, e
// "mesa regulável" com regras de teleatendimento; as duas saíram fracas e gastaram o tempo do editor. Contar
// evidências da 1ª pergunta não pegava nenhuma das duas (17 e 9 evidências): quem julga é um modelo, com as
// evidências na mão. As regras aceitas vão para o redator como base da resposta curta e do "Como decidir".

export const NOTE_PREFIX = 'Regra de decisão sustentada:';
const WORKPLACE = /NR-?\s?17|teleatendimento|telemarketing|empregador|posto de trabalho|trabalhador/i;

const BUYER_CLASS = new Set(['manufacturer', 'independent_test', 'standard_body']);
export function buyerRules<R extends { rule: string; claim_ids: string[] }>(rules: R[], classOfClaim: (id: string) => string | undefined): R[] {
  return rules.filter((x) => x.claim_ids.some((id) => BUYER_CLASS.has(classOfClaim(id) ?? '')) && !WORKPLACE.test(x.rule));
}

export interface Readiness {
  ready: boolean;
  rules: { rule: string; claim_ids: string[] }[];
  missing: string[];
  queries: string[];
}

const SYSTEM = () => `Você é o editor de pauta do site ${loadNiche().brand} (${loadNiche().scope}), que só escreve o que fontes primárias dizem, para ${loadNiche().audience}.
Antes de redigir, decida se as evidências abaixo bastam para uma página que diga ao leitor O QUE ESCOLHER na dúvida dada.
"rules": as regras de escolha que as evidências sustentam, no formato "Se você <situação ou medida do comprador>, <escolha ou confira X>", cada uma com os claim_ids que a sustentam. A regra tem de DIFERENCIAR as opções da dúvida (em "A ou B", diz quando A e quando B; em guia de compra, diz o que escolher conforme um dado do comprador). Não conta como regra: definição do produto, o que o selo avalia, regra de um setor específico (teleatendimento, obrigação do empregador), dado que serve igual para todas as opções (ex.: densidade por peso numa dúvida entre tipos de colchão).
"ready": true só se houver pelo menos 2 regras assim, de fonte voltada a quem compra.
"missing": se não estiver pronta, qual informação de fonte primária faria a página decidir (curto, concreto).
"queries": até 3 buscas na web, em português, para achar essa informação em páginas de fabricante, norma ou regulador.`;

export async function decisionReadiness(slug: string, topic: TopicBrief, fetchImpl?: FetchLike): Promise<Readiness> {
  const idx = buildIndex();
  const claims = selectClaims(topic, idx.claims.values(), (id) => idx.sources.get(id)?.source_class);
  if (!claims.length) return { ready: false, rules: [], missing: ['nenhuma evidência para a pauta'], queries: [] };
  const ids = claims.map((c) => c.id) as [string, ...string[]];
  const Out = z.object({
    rules: z.array(z.object({ rule: z.string().min(10), claim_ids: z.array(z.enum(ids)).min(1) })).max(5),
    ready: z.boolean(),
    missing: z.array(z.string()).max(3).default([]),
    queries: z.array(z.string()).max(3).default([]),
  });
  const r = await callJson(
    {
      role: 'auditor',
      system: SYSTEM(),
      user: `Dúvida: "${topic.primary_query}" (tipo ${topic.page_type})\n\nEvidências (${claims.length}):\n${formatClaims(claims, idx.sources)}`,
      schema: Out,
      schemaName: 'decision_readiness',
      maxTokens: 1500,
    },
    fetchImpl,
  );
  // O modelo diz; a regra decide. Conta só regra com ao menos uma evidência de fabricante, teste independente ou
  // norma técnica e sem linguagem de posto de trabalho: no teste de 22/10 o modelo aprovou a mesa regulável com
  // duas regras tiradas só da NR-17 ("a NR-17 orienta que o posto favoreça a alternância").
  const rules = buyerRules(r.data.rules, (id) => idx.sources.get(idx.claims.get(id)?.source_id ?? '')?.source_class);
  const ready = r.data.ready && rules.length >= 2;
  const missing = ready || r.data.missing.length ? r.data.missing : ['regras de escolha para quem compra, de fabricante ou norma técnica (não de posto de trabalho)'];
  return { ...r.data, rules, missing, ready };
}

// Grava as regras aceitas como nota editorial da pauta (o redator lê as notas), trocando as de uma checagem anterior.
export function saveRules(slug: string, topic: TopicBrief, rules: Readiness['rules']): void {
  const notes = topic.editorial_notes.filter((n) => !n.startsWith(NOTE_PREFIX));
  const fresh = rules.map((x) => `${NOTE_PREFIX} ${x.rule} (evidências: ${x.claim_ids.join(', ')})`);
  writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...topic, editorial_notes: [...notes, ...fresh] }));
}

export function logReadiness(runId: string, round: number, r: Readiness): void {
  writeStage(runId, `readiness-${round}`, r);
}
