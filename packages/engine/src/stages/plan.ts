import { editorLessonsPrompt } from '../editor-lessons.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Slug, TopicBrief } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { computeLearning } from '../learning.ts';
import { loadNiche } from '../niche.ts';
import { TOPICS_DIR, writeJson } from '../store.ts';

// Planeja uma pauta a partir só da dúvida principal: perguntas que fontes primárias conseguem
// responder, termos de foco para a triagem e tipos de produto do perfil de nicho.

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

export async function planTopic(primaryQuery: string, fetchImpl?: FetchLike): Promise<{ topic: TopicBrief; created: boolean }> {
  const slug = Slug.parse(slugify(primaryQuery));
  const path = join(TOPICS_DIR, `${slug}.json`);
  if (existsSync(path)) return { topic: TopicBrief.parse(JSON.parse(readFileSync(path, 'utf8'))), created: false };

  const niche = loadNiche();
  const kinds = niche.product_kinds.map((k) => k.id) as [string, ...string[]];
  const gaps = computeLearning().recurringGaps.map((g) => g.gap).slice(0, 8);
  const Out = z.object({
    page_type: z.enum(['decision_compare', 'buying_guide', 'explainer']),
    questions: z.array(z.object({ id: z.string().regex(/^q_[a-z0-9_]+$/), text: z.string().min(15) })).min(4),
    focus_terms: z.array(z.string().min(2)).min(2).max(8),
    listing_terms: z.array(z.string().min(2)).default([]),
    // Sem limite rígido (23/10: 5 itens derrubavam a pauta inteira); o excesso é cortado depois.
    product_kinds: z.array(z.enum(kinds)),
    editorial_notes: z.array(z.string()),
  });
  const r = await callJson(
    {
      role: 'planner',
      system:
        `Você planeja pautas para o site ${niche.brand} (${niche.scope}), que só escreve o que fontes primárias dizem ` +
        `(reguladores, normas, páginas oficiais de fabricantes). Reguladores típicos: ${niche.regulator_hints.join('; ')}.\n` +
        `Regra de segurança do site: ${niche.safety_rule}\n\n` +
        `Público: ${niche.audience}. As perguntas são as DESSE leitor na hora da compra (o que conferir, como escolher para o ` +
        `próprio caso, o que muda entre as opções); norma e regulador entram como apoio a essas perguntas, nunca como eixo ` +
        `("o que a norma exige do empregador" não é dúvida de quem compra). 21/10: a pauta de cadeira virou um guia da NR-17.\n` +
        `Para a dúvida dada, gere de 4 a 7 perguntas que, respondidas, permitem ao leitor DECIDIR. Prefira perguntas que um ` +
        `fabricante, uma norma ou um regulador costumam responder por escrito (definições, requisitos, especificações, ` +
        `o que a etiqueta deve informar). Evite perguntas que dependem de teste prático, preço ou opinião.\n` +
        `A PRIMEIRA pergunta é sempre a do dado que decide: qual medida ou característica de quem compra (peso, altura, ` +
        `posição de dormir, horas de uso, tamanho do quarto) indica cada opção, e com quais valores ou faixas segundo o ` +
        `fabricante ou a norma. É ela que vira a resposta curta e a tabela do "Como decidir" (22/10: as páginas que o ` +
        `editor aprovou de primeira cruzam duas grandezas, como peso e densidade).\n` +
        `Pauta "A ou B": uma pergunta por opção pedindo o dado que a distingue (medida, capacidade, densidade), com o nome da ` +
        `opção na pergunta, para nenhuma ficar sem fonte (23/10: "solteirão ou viúva" saiu sem a medida do solteirão).\n` +
        `"focus_terms": palavras que um trecho de fonte útil quase certamente contém (curtas, em minúsculas).\n` +
        `"listing_terms": só quando a dúvida é sobre um item que apenas alguns produtos do tipo têm (ex.: "pillow top", "baú", "apoio de cabeça"): as palavras que o título do anúncio precisa ter para o produto servir de exemplo. Também quando a dúvida é entre tamanhos: os tamanhos comparados (ex.: ["solteiro", "solteirão", "viúva"]), senão a página mostra colchão casal numa dúvida de solteiro. Vazio quando qualquer produto do tipo serve (ex.: "colchão firme ou macio").\n` +
        `"product_kinds": só os tipos do vocabulário que a página vai explicar.` +
        editorLessonsPrompt(),
      user:
        `Dúvida principal: "${primaryQuery}"\n` +
        (gaps.length ? `\nEm pautas anteriores, estas informações NÃO foram encontradas em texto de fonte primária; não dependa delas para a decisão:\n${gaps.map((g) => `- ${g}`).join('\n')}\n` : ''),
      schema: Out,
      schemaName: 'topic_plan',
      maxTokens: 2500,
    },
    fetchImpl,
  );
  const topic = TopicBrief.parse({ slug, primary_query: primaryQuery, ...r.data, questions: r.data.questions.slice(0, 7), product_kinds: r.data.product_kinds.slice(0, 4), editorial_notes: r.data.editorial_notes.slice(0, 4), listing_terms: r.data.listing_terms.slice(0, 3), source_ids: [] });
  writeJson(path, topic);
  return { topic, created: true };
}
