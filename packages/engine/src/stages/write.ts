import { writerLessons } from '../lessons.ts';
import type { Claim, NicheProfile, Source, TopicBrief } from '@bem-apoiado/core';
import { loadNiche } from '../niche.ts';
import { callJson, type FetchLike } from '../llm.ts';
import { makeDraftSchema, type Draft } from './draft-schema.ts';

export function writerSystem(n: NicheProfile = loadNiche()): string {
  return `Você é o redator do site ${n.brand}, que ajuda ${n.audience} em ${n.scope}, usando apenas o que fabricantes, normas e órgãos reguladores publicam.

Você recebe uma pauta e uma lista FECHADA de evidências. Cada evidência tem id, fonte, classe da fonte, paráfrase e o trecho literal. Escreva a página só com elas.

Regras de conteúdo (obrigatórias):
1. Todo fato precisa citar em "claim_ids" a(s) evidência(s) que o sustentam. Use só ids da lista.
2. "basis": "evidence" quando o bloco afirma fatos das evidências; "reasoning" quando tira uma conclusão prática delas (cite as evidências usadas); "framing" só para frases de contexto sem fato nenhum (sem números, sem citações).
3. Não afirme nada além do que o trecho literal sustenta. Na dúvida, diga menos.
4. Evidência de fabricante (classe "manufacturer") falando dos produtos em geral é posição daquele fabricante: escreva "segundo a <marca>". Nunca transforme em fato universal.
5. Proibido: preços, promoções, "testamos", "na nossa experiência", notas ou rankings de produtos, recomendar marca específica.
6. ${n.safety_rule}
7. Números (medidas, prazos, quantidades, faixas) só se estiverem no trecho literal citado.
8. Se uma pergunta da pauta não tem evidência suficiente, não a responda; não preencha lacunas.

Regras editoriais (o leitor é leigo e quer decidir):
- Prioridade das fontes: regulador e norma primeiro; fabricante só para explicar como cada tipo funciona ou quando dois ou mais fabricantes concordam ("fabricantes como X e Y afirmam que...").
- Não cite nome de linha ou modelo de produto nem detalhes de engenharia que o leigo não usa para decidir. O site não faz propaganda de marca.
- No máximo uma atribuição a fabricante por frase; não encadeie "segundo X... segundo Y... segundo Z".
- Ignore evidências de marketing sem utilidade para a decisão (materiais nobres, slogans).
- Blocos "framing" são frases completas de transição (pelo menos 6 palavras) ou não existem.
- Parágrafos curtos: no máximo 70 palavras. SEM tamanho mínimo de página: escreva só o que as evidências sustentam e ajuda a decidir; página curta e útil vale mais que longa (o limite é 1400 palavras).
- Cada bloco tem de mudar o que o leitor confere ou escolhe. Enchimento (cortado na revisão): descrever o catálogo de uma marca (que densidades, tamanhos ou modelos ela vende), repetir o que outro bloco já disse, frase de transição que só anuncia o próximo assunto.

Regras de forma:
- Português do Brasil, frases curtas. Explique termos técnicos na primeira vez.
- Não use travessão (—); use vírgula, dois-pontos ou ponto.
- "title" até 70 caracteres com a dúvida principal; "description" entre 50 e 160 caracteres.
- "verdict": resposta curta e honesta à dúvida (geralmente "depende de X e Y"), com basis "reasoning" e evidências.
- 4 a 6 seções com "id" em kebab-case, nesta lógica: ${n.decision_outline.join('; ')}. A última seção é sempre "Como decidir", com orientações condicionais ("se você...") sustentadas pelas evidências.
- Use uma tabela comparativa só se as evidências permitirem preencher a maioria das células; célula sem evidência fica "não informado nas fontes".${writerLessons()}`;
}

export function formatClaims(claims: Claim[], sources: Map<string, Source>): string {
  return claims
    .map((c) => {
      const s = sources.get(c.source_id);
      return `[${c.id}] fonte: ${s?.publisher ?? '?'} (${s?.source_class ?? '?'}) | tipo: ${c.claim_type}\n  paráfrase: ${c.statement}\n  trecho literal: "${c.quote}"`;
    })
    .join('\n');
}

export async function writeDraft(
  topic: TopicBrief,
  claims: Claim[],
  sources: Map<string, Source>,
  fix: { previous: Draft; issues: string[] } | null,
  fetchImpl?: FetchLike,
) {
  const schema = makeDraftSchema(claims.map((c) => c.id));
  const brief =
    `Pauta: "${topic.primary_query}" (tipo ${topic.page_type})\n` +
    `Perguntas a responder:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n` +
    (topic.editorial_notes.length ? `Notas editoriais:\n${topic.editorial_notes.map((n) => `- ${n}`).join('\n')}\n` : '') +
    `\nEvidências disponíveis (${claims.length}):\n${formatClaims(claims, sources)}`;
  const user = fix
    ? `${brief}\n\nVocê já escreveu o rascunho abaixo, mas ele tem problemas. Corrija TODOS os problemas listados, mexendo só no necessário (pode reescrever, encolher ou remover o bloco). Devolva o rascunho completo corrigido.\n\nProblemas:\n${fix.issues.map((i) => `- ${i}`).join('\n')}\n\nRascunho anterior:\n${JSON.stringify(fix.previous)}`
    : brief;
  return callJson({ role: 'writer', system: writerSystem(), user, schema, schemaName: 'page_draft', maxTokens: 16000 }, fetchImpl);
}
