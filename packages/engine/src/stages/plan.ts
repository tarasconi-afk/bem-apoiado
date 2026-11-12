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

export async function planTopic(primaryQuery: string, fetchImpl?: FetchLike): Promise<{ topic: TopicBrief; created: boolean; added: string[] }> {
  const slug = Slug.parse(slugify(primaryQuery));
  const path = join(TOPICS_DIR, `${slug}.json`);
  if (existsSync(path)) return { topic: TopicBrief.parse(JSON.parse(readFileSync(path, 'utf8'))), created: false, added: [] };

  const niche = loadNiche();
  const kinds = niche.product_kinds.map((k) => k.id) as [string, ...string[]];
  const gaps = computeLearning().recurringGaps.map((g) => g.gap).slice(0, 8);
  const Out = z.object({
    page_type: z.enum(['decision_compare', 'buying_guide', 'explainer']),
    questions: z.array(z.object({ id: z.string().regex(/^q_[a-z0-9_]+$/), text: z.string().min(15), focus: z.enum(QUESTION_FOCUS).default('outro') })).min(4),
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
        // 28/10, o editor sobre o rascunho de edredom ou cobertor: "sinto falta de diferenças na limpeza, espaço
        // para guardar". Não foi o redator que omitiu — nenhuma das 7 perguntas da pauta tratava disso, e a
        // página só responde o que a pauta perguntou. A regra acima, de priorizar o dado que decide, deixara o
        // planejador cego para critério que não é medida de produto.
        `Nem todo critério de decisão é medida de desempenho: quem compra também escolhe pelo trabalho que a peça dá e pelo ` +
        `espaço que ocupa. Quando o produto tiver cuidado de conservação na etiqueta ou na ficha (têxteis, capas, ` +
        `revestimentos), UMA das perguntas é sobre lavar e secar — o que o fabricante ou a norma de etiquetagem ` +
        // 03/11: "e guardar" saiu. Nenhuma etiqueta nem norma de etiquetagem fala de como guardar a peça, então a
        // pergunta nunca tinha resposta e a seção nascia prometendo o que não entregava ("O que a etiqueta informa
        // sobre lavar e guardar", travesseiro de corpo). Regra minha de 28/10, que produzia a falha nº 1 da semana.

        `mandam informar. Quando a peça for volumosa guardada, peça o peso e as medidas que o fabricante declara, e só ` +
        // 29/10: a pergunta saía com a finalidade colada ("para quem tem pouco espaço de armário"), e o redator a
        // repetia como conclusão: o juiz de coerência recusou ("os trechos não relacionam essas medidas à
        // facilidade de armazenar") e a correção automática voltou OVERSTATED. A pergunta pede o dado; quem
        // conclui se cabe no armário é o leitor.
        `isso: nada de colar na pergunta para que serve o dado ("para quem tem pouco espaço", "para saber se cabe"), ` +
        `porque a ficha declara a medida e não o que ela resolve. Continua valendo: só o que ` +
        `fabricante, norma ou regulador respondem por escrito; nada de teste prático, preço ou opinião.\n` +
        // 03/11, pauta "cama box conjugada ou bipartida": as fichas da Probel diziam "Base: Bipartida (Dois
        // Volumes)", traziam as medidas e "Verifique se as dimensões dos produtos passam por elevadores, portas,
        // escadas e corredores" — a resposta que o leitor precisa. As perguntas pediam a medida de CADA módulo,
        // o peso de CADA peça e "a medida de acesso que o fabricante indica como critério, com valores"; nenhuma
        // ficha publica isso, a triagem descartou as fichas e a pauta esgotou sem página, com a fonte em mãos.
        `Pergunte o dado na forma em que a ficha do produto costuma publicá-lo (tipo, medidas totais, aviso do ` +
        `fabricante, capacidade), não numa forma mais fina que nenhuma ficha traz (medida de cada módulo, peso de cada ` +
        `peça, "o critério X com valores" quando o fabricante só avisa para conferir). Pergunta que exige o que não é ` +
        `publicado faz a pesquisa descartar a fonte que responde.\n` +
        // 12/11: travesseiro de pena ou fibra nasceu com 6 perguntas de etiqueta/ficha e a página saiu só sobre lavagem.
        // O "focus" é enum fechado; a cobertura é conferida no código (ensureReaderQuestions), não só pedida aqui.
        `"focus" de cada pergunta: "dado_que_decide" (a primeira), "opcao" (dado de uma das opções), "uso" (como a peça se ` +
        `comporta no uso: maciez, firmeza, sustentação, calor, desempenho), "restricao" (cheiro, calor, ` +
        `segurança), "cuidado" (lavar, secar, conservar), "etiqueta_ficha" (o que a etiqueta ou a ficha deve declarar) ou ` +
        `"outro". Em pauta de decisão, pelo menos uma pergunta "uso"; se o produto encosta no corpo (roupa de cama, banho, ` +
        `travesseiro, colchão), também uma "restricao", sempre pelo que fabricante ou órgão informa por escrito e nunca ` +
        `pedindo benefício para a saúde.\n` +
        `"focus_terms": palavras que um trecho de fonte útil quase certamente contém (curtas, em minúsculas), com as ` +
        `variações de gênero e número que a ficha pode usar ("bipartido" e "bipartida": a base é "o box").\n` +
        `"listing_terms": só quando a dúvida é sobre um item que apenas alguns produtos do tipo têm (ex.: "pillow top", "baú", "apoio de cabeça"): as palavras que o título do anúncio precisa ter para o produto servir de exemplo. Também quando a dúvida é entre tamanhos: os tamanhos comparados (ex.: ["solteiro", "solteirão", "viúva"]), senão a página mostra colchão casal numa dúvida de solteiro. Vazio quando qualquer produto do tipo serve (ex.: "colchão firme ou macio").\n` +
        `"product_kinds": só os tipos do vocabulário que a página vai explicar.` +
        editorLessonsPrompt(),
      user:
        `Dúvida principal: "${primaryQuery}"\n` +
        (gaps.length ? `\nEm pautas anteriores, estas informações NÃO foram encontradas em texto de fonte primária; não dependa delas para a decisão:\n${gaps.map((g) => `- ${g}`).join('\n')}\n` : ''),
      schema: Out,
      schemaName: 'topic_plan',
      // 09/11: com 2500, TODA primeira chamada do planejador custava 4,67 créditos — o valor exato de 2500 tokens de
      // saída do Sonnet 5 — e voltava JSON cortado; a segunda tentativa às vezes salvava. Nos ciclos das 04h de 07, 08 e
      // 09/11 as duas falharam e o ciclo terminou sem página (≈9 créditos e uma página perdidos por dia).
      maxTokens: 6000,
    },
    fetchImpl,
  );
  const bodyContact = r.data.product_kinds.some((k) => niche.product_kinds.find((x) => x.id === k)?.body_contact);
  const ensured = ensureReaderQuestions(primaryQuery, r.data.page_type, bodyContact, r.data.questions);
  const topic = TopicBrief.parse({ slug, primary_query: primaryQuery, ...r.data, questions: ensured.questions.map(({ id, text }) => ({ id, text })), product_kinds: r.data.product_kinds.slice(0, 4), editorial_notes: r.data.editorial_notes.slice(0, 4), listing_terms: r.data.listing_terms.slice(0, 3), source_ids: [] });
  writeJson(path, topic);
  return { topic, created: true, added: ensured.added };
}

// ─── Perguntas do leitor (12/11) ────────────────────────────────────────────────────────────────────────────────
// A página só responde o que a pauta pergunta. O planejador, puxado para o que fabricante e norma publicam, gerava
// pautas inteiras de etiqueta e ficha (travesseiro de pena ou fibra: 6 de 6), e a página não dizia ao leitor como a
// peça se comporta no uso nem se serve para quem tem alergia. Regra conferida pelo TEXTO da pergunta (o rótulo do
// modelo só ajuda a escolher qual substituir): falta → entra uma pergunta de modelo fixo, sem alegação terapêutica.
export const QUESTION_FOCUS = ['dado_que_decide', 'opcao', 'uso', 'restricao', 'cuidado', 'etiqueta_ficha', 'outro'] as const;
export type QuestionFocus = (typeof QUESTION_FOCUS)[number];
type PlannedQuestion = { id: string; text: string; focus: QuestionFocus };
export const MAX_QUESTIONS = 7;

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const COVERS_USE = /(conforto|confortav|macie|macio|firmeza|\bfirme|sustenta|sensac|\btoque|desempenho|no uso|durante o uso|ao dormir|ao deitar|ao usar|aconchego|maleab|acomoda|molda|absorc|absorv)/;
export const COVERS_RESTRICTION = /(cheiro|odor|calor|transpira|seguranc|ruido|inflamav|toxic)/; // alergia não conta: regra de saúde do site
const LABEL_LIKE = /(etiqueta|ficha|inmetro|norma|declar|composic|percentual|gramatura|dimens|medida)/;

export function ensureReaderQuestions(
  primaryQuery: string,
  pageType: 'decision_compare' | 'buying_guide' | 'explainer',
  bodyContact: boolean,
  input: PlannedQuestion[],
): { questions: PlannedQuestion[]; added: string[] } {
  let qs = input.slice(0, MAX_QUESTIONS);
  const added: string[] = [];
  if (pageType === 'explainer') return { questions: qs, added };
  const q = primaryQuery.trim().replace(/[?.!\s]+$/, '');
  const want: { focus: QuestionFocus; re: RegExp; q: PlannedQuestion; label: string }[] = [
    {
      focus: 'uso', re: COVERS_USE, label: 'uso (conforto/desempenho)',
      q: { id: 'q_uso_leitor', focus: 'uso', text: `Em "${q}", o que os fabricantes declaram sobre como cada opção se comporta no uso (maciez, firmeza, sustentação, altura) e para qual perfil de uso indicam cada uma?` },
    },
  ];
  if (bodyContact) want.push({
    // 12/11: sem alergia e ácaros. A regra de saúde do site (niche.json) barra "antialérgico" mesmo atribuído ao
    // fabricante (travesseiro: 3 tentativas recusadas como SAFETY_CLAIM); pesquisar isso era gasto sem página.
    focus: 'restricao', re: COVERS_RESTRICTION, label: 'restrição (calor/cheiro/segurança)',
    q: { id: 'q_restricao_leitor', focus: 'restricao', text: `Em "${q}", o que fabricantes, Inmetro ou órgãos de defesa do consumidor informam por escrito sobre retenção de calor, cheiro, ruído ou cuidados de segurança de cada opção?` },
  });
  for (const w of want) {
    if (qs.some((x) => w.re.test(fold(x.text)))) continue;
    let replaced = '';
    if (qs.length >= MAX_QUESTIONS) {
      // Sai a mais redundante: a última de etiqueta/ficha quando há pelo menos duas; senão a última que não é a
      // primeira (o dado que decide) nem uma pergunta do leitor já garantida.
      const labelIdx = qs.map((x, i) => ({ x, i })).filter(({ x, i }) => i > 0 && (x.focus === 'etiqueta_ficha' || LABEL_LIKE.test(fold(x.text))) && !x.id.endsWith('_leitor')).map(({ i }) => i);
      const idx = labelIdx.length >= 2 ? labelIdx[labelIdx.length - 1]! : [...qs.keys()].reverse().find((i) => i > 0 && !qs[i]!.id.endsWith('_leitor'))!;
      replaced = ` no lugar de "${qs[idx]!.text.slice(0, 60)}…"`;
      qs = qs.filter((_, i) => i !== idx);
    }
    const id = qs.some((x) => x.id === w.q.id) ? `${w.q.id}_2` : w.q.id;
    qs.push({ ...w.q, id });
    added.push(`${w.label}${replaced}`);
  }
  return { questions: qs, added };
}
