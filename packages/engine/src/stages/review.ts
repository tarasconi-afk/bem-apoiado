import { z } from 'zod';
import type { PageSpec, ReviewMetrics, TopicBrief } from '@bem-apoiado/core';
import { editorialChecklist } from '@bem-apoiado/core';
import { loadNiche } from '../niche.ts';
import { callJson, type FetchLike } from '../llm.ts';
import { blockRefs } from './draft-schema.ts';
import { loadThresholds, ruleDecides } from '../feedback.ts';
import { examplesPrompt, judgeCalibration } from '../exemplars.ts';

// Revisão editorial: a auditoria garante que cada frase tem prova; esta etapa julga se a página
// SERVE para quem buscou. Página correta mas inútil (não responde, não orienta) não vai ao ar.

const system = () => `Você é o editor-chefe do site ${loadNiche().brand}. Avalie se a página abaixo merece ser publicada para quem pesquisou a dúvida principal no Google.
Não julgue a veracidade (isso já foi auditado). Julgue a utilidade pelo padrão editorial do site.
As "perguntas da pauta" são o roteiro de PESQUISA: muitas não têm resposta em fonte primária e isso não reprova a página; elas só servem para o campo "missing". Os campos de avaliação julgam a dúvida PRINCIPAL de quem buscou.
Responder à dúvida é dar a regra de escolha, mesmo com outras palavras que as da busca: para "colchão firme ou macio", "escolha a densidade pelo seu peso: até 60 kg, D23 a D26…" responde, porque densidade é como a firmeza aparece na etiqueta.
Padrão editorial:
${editorialChecklist()}
Campos:
- "answers_primary_query": a página responde à dúvida principal de forma direta? "yes" se a resposta curta e o "Como decidir" dão ao leitor uma regra de escolha para o caso dele (por peso, medida, uso), mesmo que as fontes não cubram todos os casos; "partial" se só parte da dúvida tem regra; "no" se não há regra nenhuma.
- "concrete_guidance": o leitor sai sabendo o que fazer ou conferir na prática? (true/false)
- "reader_fit": a página fala com o público do site (${loadNiche().audience})? false se: a resposta curta ou "Como decidir" usam jargão sem explicar (ex.: "antropométricas", nomes de mecanismo), se o ponto de vista é de outro público (obrigação do empregador, fiscalização, linguagem de norma) em vez de quem vai comprar, ou se "Como decidir" se apoia numa marca só quando a página cita outras.
- "quick_answer": a resposta curta, lida sozinha, diz o que escolher ou fazer com um dado concreto (faixa de peso, medida, capacidade), em até 3 frases e sem jargão? Citar a fonte ("segundo a Castor") não a torna lenta. false só se ela é genérica ("depende", "considere suas necessidades"), só descreve o produto sem dizer o que escolher, ou usa termo técnico sem explicar. (true/false)
- "purchase_path": o leitor sai sabendo o que conferir no anúncio ou na ficha e qual opção serve para o caso dele? (true/false; sem pressão de venda)
- "reader_problems": o que impede o leitor leigo de usar a página (vazio se reader_fit).
- "filler_refs": refs de blocos que não acrescentam NADA: repetem outro bloco quase com as mesmas palavras, ou são frase vaga sem dado ("é importante escolher bem"). Detalhe técnico com fonte (especificação, norma, o que o regulador avalia) NÃO é enchimento: é a parte "Detalhes técnicos" da página, que sustenta a resposta curta. Na dúvida, não marque.
- "decision_criteria": liste os critérios CONCRETOS de decisão que a página dá ao leitor (ex.: "se divide a cama, molas ensacadas reduzem transferência de movimento"). Frases genéricas como "considere suas necessidades" ou "consulte o fabricante" não contam.
- "missing": que tipo de informação, se encontrada em fonte primária, faria a página responder bem (ex.: "tabela do fabricante relacionando densidade e peso").
- "publishable": sua opinião geral.
O site só usa fontes primárias e não inventa: uma página pode responder parcialmente porque as fontes não dizem mais. Isso é aceitável se ela dá critérios concretos; não é aceitável se ela é só "depende" e enchimento.`;

export interface ReviewResult {
  model_opinion?: boolean;
  answers_primary_query: 'yes' | 'partial' | 'no';
  concrete_guidance: boolean;
  reader_fit?: boolean;
  quick_answer?: boolean;
  purchase_path?: boolean;
  reader_problems?: string[];
  coherence?: { check: string; ref: string; problem: string; fix: string }[]; // auditoria de coerência (page.ts)
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
    reader_fit: z.boolean().default(true),
    quick_answer: z.boolean().default(true),
    purchase_path: z.boolean().default(true),
    reader_problems: z.array(z.string()).default([]),
    filler_refs: z.array(z.enum(refs)),
    decision_criteria: z.array(z.string()),
    missing: z.array(z.string()),
    publishable: z.boolean(),
    summary: z.string(),
  });
  const ask = () =>
    callJson(
      {
        role: 'auditor',
        system: system(),
        user:
          `Dúvida principal: "${topic.primary_query}"\nPerguntas da pauta:\n${topic.questions.map((q) => `- ${q.text}`).join('\n')}\n\n` +
          `Página: ${page.title}\n` +
          units.map((u) => `[${u.ref}] ${u.text}`).join('\n') +
          examplesPrompt('judge', { pageType: page.page_type, exclude: page.slug, max: 3 }) +
          judgeCalibration(page.slug),
        schema: Out,
        schemaName: 'editorial_review',
        maxTokens: 2500,
      },
      fetchImpl,
    );
  // 3 avaliações, vale a maioria em cada pergunta (22/10: o mesmo juiz, na mesma página sem mudança, deu
  // "publicar" numa rodada e "não" na seguinte; o modelo não aceita fixar a aleatoriedade). Falha de uma
  // chamada não derruba: decide com as que voltaram.
  const runs = (await Promise.allSettled([ask(), ask(), ask()])).flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []));
  if (!runs.length) throw new Error('revisão: nenhuma das 3 avaliações voltou');
  const r = { data: majority(runs.map((x) => x.data)), usage: runs.map((x) => x.usage).reduce((a, b) => ({ ...a, input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens })) };
  // Decisão determinística: o modelo descreve, a regra decide. Os limites vêm da calibração contra os
  // vereditos do editor (data/calibration.json; sem ela, 25% de enchimento e 2 critérios).
  // A opinião "publishable" do modelo é só registrada. Partial é aceito: fonte primária tem limite.
  const d = r.data;
  const filler_ratio = new Set(d.filler_refs).size / units.length;
  const publishable = ruleDecides(
    { answers_primary_query: d.answers_primary_query, concrete_guidance: d.concrete_guidance, reader_fit: d.reader_fit, quick_answer: d.quick_answer, filler_ratio, criteria: d.decision_criteria.length, rule_publishable: false },
    loadThresholds(),
  );
  // Problemas de leitura entram em "missing": viram lacuna da pauta e o "completar o que faltou" do painel.
  return { review: { ...d, missing: [
    ...(d.quick_answer ? [] : ['Resposta curta que resolva sozinha a dúvida simples, em até 3 frases e sem jargão']),
    ...(d.purchase_path ? [] : ['O que conferir no anúncio ou na ficha para escolher a opção certa para cada caso']),
    ...d.reader_problems.map((x) => `Para o leitor leigo: ${x}`), ...d.missing], filler_ratio, model_opinion: d.publishable, publishable } as ReviewResult, usage: r.usage };
}

export function reviewMetrics(r: ReviewResult): ReviewMetrics {
  return { answers_primary_query: r.answers_primary_query, concrete_guidance: r.concrete_guidance, ...(r.reader_fit === undefined ? {} : { reader_fit: r.reader_fit }), ...(r.quick_answer === undefined ? {} : { quick_answer: r.quick_answer }), filler_ratio: r.filler_ratio, criteria: r.decision_criteria.length, rule_publishable: r.publishable };
}

// Causa curta de uma reprovação, para o passo do ciclo (27/10): sem ela, "page: NOT_PUBLISHABLE" não dizia se
// foi o juiz, a regra de enchimento ou a coerência, e medir a aprovação de primeira por causa exigia abrir cada run.
export function failureCause(r: Pick<ReviewResult, 'coherence' | 'answers_primary_query' | 'concrete_guidance' | 'reader_fit' | 'quick_answer' | 'filler_ratio' | 'decision_criteria'>): string {
  if (r.coherence?.length) return `coerência: ${[...new Set(r.coherence.map((c) => c.check))].join(', ')}`;
  const flags = [r.answers_primary_query === 'no' ? 'não decide' : '', r.concrete_guidance ? '' : 'sem orientação concreta', r.reader_fit === false ? 'não é para leigo' : '', r.quick_answer === false ? 'sem resposta rápida' : ''].filter(Boolean);
  if (flags.length) return `revisão: ${flags.join(', ')}`;
  return `regra: enchimento ${Math.round(r.filler_ratio * 100)}%, ${r.decision_criteria.length} critério(s)`;
}

type Vote = { answers_primary_query: 'yes' | 'partial' | 'no'; concrete_guidance: boolean; reader_fit: boolean; quick_answer: boolean; purchase_path: boolean; reader_problems: string[]; filler_refs: string[]; decision_criteria: string[]; missing: string[]; publishable: boolean; summary: string };
// Maioria por campo; enchimento = bloco apontado pela maioria; o texto (resumo, critérios, faltas) vem da
// avaliação mais alinhada com a maioria.
export function majority<T extends Vote>(vs: T[]): T {
  const half = vs.length / 2;
  const yes = (k: keyof Vote) => vs.filter((v) => v[k] === true).length > half;
  const order = ['yes', 'partial', 'no'] as const;
  const counts = order.map((o) => vs.filter((v) => v.answers_primary_query === o).length);
  // Empate (3 respostas diferentes): o meio, "partial".
  const best = Math.max(...counts);
  const answers = counts.filter((c) => c === best).length > 1 ? 'partial' : order[counts.indexOf(best)]!;
  const filler = [...new Set(vs.flatMap((v) => v.filler_refs))].filter((ref) => vs.filter((v) => v.filler_refs.includes(ref)).length > half);
  const agg = { answers_primary_query: answers, concrete_guidance: yes('concrete_guidance'), reader_fit: yes('reader_fit'), quick_answer: yes('quick_answer'), purchase_path: yes('purchase_path'), publishable: yes('publishable') };
  const score = (v: T) => (Object.keys(agg) as (keyof typeof agg)[]).filter((k) => v[k] === agg[k]).length;
  const rep = [...vs].sort((a, b) => score(b) - score(a))[0]!;
  return { ...rep, ...agg, filler_refs: filler };
}

// Nota de leitor de 0 a 4 (as 4 perguntas do editor; "em parte" vale meio): usada para comparar duas versões.
export function readerScore(r: { answers_primary_query: string; reader_fit?: boolean; quick_answer?: boolean; purchase_path?: boolean }): number {
  const dec = r.answers_primary_query === 'yes' ? 1 : r.answers_primary_query === 'partial' ? 0.5 : 0;
  return dec + Number(r.reader_fit !== false) + Number(r.quick_answer !== false) + Number(r.purchase_path !== false);
}
