import { z } from 'zod';
import type { PageSpec, TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { blockRefs } from './draft-schema.ts';

// Revisão editorial: a auditoria garante que cada frase tem prova; esta etapa julga se a página
// SERVE para quem buscou. Página correta mas inútil (não responde, não orienta) não vai ao ar.

const SYSTEM = `Você é o editor-chefe do site Bem Apoiado. Avalie se a página abaixo merece ser publicada para quem pesquisou a dúvida principal no Google.
Não julgue a veracidade (isso já foi auditado). Julgue a utilidade:
- "answers_primary_query": a página responde à dúvida principal de forma direta? "yes", "partial" ou "no".
- "concrete_guidance": o leitor sai sabendo o que fazer ou conferir na prática? (true/false)
- "filler_refs": refs de blocos que não acrescentam nada (repetição, frase vaga, dado sem utilidade).
- "decision_criteria": liste os critérios CONCRETOS de decisão que a página dá ao leitor (ex.: "se divide a cama, molas ensacadas reduzem transferência de movimento"). Frases genéricas como "considere suas necessidades" ou "consulte o fabricante" não contam.
- "missing": que tipo de informação, se encontrada em fonte primária, faria a página responder bem (ex.: "tabela do fabricante relacionando densidade e peso").
- "publishable": sua opinião geral.
O site só usa fontes primárias e não inventa: uma página pode responder parcialmente porque as fontes não dizem mais. Isso é aceitável se ela dá critérios concretos; não é aceitável se ela é só "depende" e enchimento.`;

export const MAX_FILLER_RATIO = 0.25;
export const MIN_CRITERIA = 2;

export interface ReviewResult {
  model_opinion?: boolean;
  answers_primary_query: 'yes' | 'partial' | 'no';
  concrete_guidance: boolean;
  filler_refs: string[];
  decision_criteria: string[];
  missing: string[];
  filler_ratio: number;
  publishable: boolean;
  summary: string;
}

export async function reviewPage(page: PageSpec, topic: TopicBrief, fetchImpl?: FetchLike) {
  const units = blockRefs({ title: page.title, description: page.description, verdict: page.verdict, sections: page.sections });
  const refs = units.map((u) => u.ref) as [string, ...string[]];
  const Out = z.object({
    answers_primary_query: z.enum(['yes', 'partial', 'no']),
    concrete_guidance: z.boolean(),
    filler_refs: z.array(z.enum(refs)),
    decision_criteria: z.array(z.string()),
    missing: z.array(z.string()),
    publishable: z.boolean(),
    summary: z.string(),
  });
  const r = await callJson(
    {
      role: 'auditor',
      system: SYSTEM,
      user:
        `Dúvida principal: "${topic.primary_query}"\nPerguntas da pauta:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n\n` +
        `Página: ${page.title}\n` +
        units.map((u) => `[${u.ref}] ${u.text}`).join('\n'),
      schema: Out,
      schemaName: 'editorial_review',
      maxTokens: 2500,
    },
    fetchImpl,
  );
  // Decisão determinística (calibrada nas duas primeiras páginas): o modelo descreve, a regra decide.
  // A opinião "publishable" do modelo é só registrada. Partial é aceito: fonte primária tem limite.
  const d = r.data;
  const filler_ratio = new Set(d.filler_refs).size / units.length;
  const publishable =
    d.answers_primary_query !== 'no' && d.concrete_guidance && filler_ratio <= MAX_FILLER_RATIO && d.decision_criteria.length >= MIN_CRITERIA;
  return { review: { ...d, filler_ratio, model_opinion: d.publishable, publishable } as ReviewResult, usage: r.usage };
}
