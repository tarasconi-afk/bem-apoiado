import { writerLessons } from '../lessons.ts';
import { editorialChecklist, type Claim, type NicheProfile, type Source, type TopicBrief } from '@bem-apoiado/core';
import { loadNiche } from '../niche.ts';
import { loadProducts, sourceText } from '../store.ts';
import { examplesPrompt } from '../exemplars.ts';
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
4b. O que a página de um produto diz DESSE produto vale só para ele: "no colchão X, a Ortobom informa…", nunca "o pillow top oferece…" como característica do tipo (22/10: o pillow top parou na auditoria por 3 blocos assim). Para falar do tipo em geral, só com dois ou mais fabricantes dizendo o mesmo, ou norma.
4c. Chame o documento pelo que ele é, como aparece em "documento:": página do produto, guia ou artigo do fabricante, ficha técnica (só se o documento for uma ficha técnica), norma, regulamento.
5. Proibido: preços, promoções, "testamos", "na nossa experiência", notas ou rankings de produtos, recomendar marca específica.
4d. Cada evidência traz o "alcance". Com alcance "SÓ O PRODUTO", o dado (medida, peso suportado, garantia, densidade) entra com o nome do modelo e da marca ("no Prohotel Royal da Probel, o solteirão mede 100 × 200 cm"); nunca "o solteirão mede 100 × 200 cm" ou "o viúva suporta 120 kg". Para dizer que um tamanho ou tipo "mede" ou "suporta" algo, use uma evidência de alcance "regra geral" ou de guia do fabricante que fale do tamanho ou do tipo, e não de um produto; se só houver fichas de produto, escreva "nos modelos citados de X e Y". Tabela "tamanho × medida" com dado de produto diz de qual modelo é cada célula (na célula ou no título da tabela).
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

Exemplo de página que o editor aprovou como modelo (colchão firme ou macio, 22/10). Imite a FORMA, nunca o conteúdo:
- Resposta curta: "Escolha a densidade pelo seu peso: até 60 kg, a Castor indica densidades 23 a 26; de 61 a 80 kg, 28 a 33; acima de 80 kg, 33 a 45 ou mais. Quem dorme de lado pode buscar uma superfície que alivie a pressão em ombros e quadris, segundo a King Koil." (começa pela ação do leitor, traz o dado que decide, diz de quem é, 2 frases)
- "Como decidir": uma tabela "Densidade recomendada pela Castor para cada faixa de peso" (Faixa de peso | Densidade recomendada, 6 linhas, cada célula com a fonte) e uma orientação curta por posição de dormir. Os detalhes técnicos ficam nas outras seções, sem repetir a tabela em texto.

Padrão editorial (cada bloco tem de passar nestas perguntas; a revisão reprova a página que não passa):
${editorialChecklist()}

Regras do gate (o código recusa a página sem ler o conteúdo; cada uma custa uma rodada inteira quando não é obedecida de primeira):
- Resposta curta ("verdict"): no máximo 3 frases; começa pela resposta prática (o que escolher e para quem), nunca por "Segundo…", "De acordo com…", "Conforme…", nem por norma, regulador ou anexo; a fonte entra no fim da frase ("…, segundo a Castor").
- Nunca escreva "trechos citados" ou "nos trechos": diga quem afirma ("segundo a Ortobom") ou o que a ficha não informa.
- Título "A ou B": a resposta curta ou o "Como decidir" dizem quando escolher A e quando escolher B, com o dado da fonte.
- Tabela: pelo menos 2 linhas; nenhuma célula "não informado" ou "confira…"; uma coluna é um modelo só; só cite "a tabela abaixo" na seção em que ela está.
- Duas orientações "Se você…" com a mesma condição não podem coexistir: junte ou diga outra situação.
- Nenhum bloco repete outro; nenhum travessão (—); parágrafo com no máximo 70 palavras; página com no máximo 1400.
- Bloco de transição que só anuncia o próximo assunto ("A seguir, veja o que os fabricantes dizem…", "Confira abaixo as informações…") é cortado: ou a frase diz algo ao leitor, ou o bloco não existe.

Regras de forma:
- Português do Brasil, frases curtas. Explique termos técnicos na primeira vez.
- Não use travessão (—); use vírgula, dois-pontos ou ponto.
- "title" até 70 caracteres com a dúvida principal; "description" entre 50 e 160 caracteres.
- "verdict": resposta curta e honesta à dúvida (geralmente "depende de X e Y"), com basis "reasoning" e evidências.
- 4 a 6 seções com "id" em kebab-case, nesta lógica: ${n.decision_outline.join('; ')}. A última seção é sempre "Como decidir", com orientações condicionais ("se você...") sustentadas pelas evidências; ela aparece no topo da página, logo abaixo da resposta curta. Tabela que ajuda a decidir (faixa de peso × densidade, tamanho × medida, modelo × ficha) fica DENTRO do "Como decidir", nunca numa seção de detalhe (o editor, 22/10: as tabelas são o que há de mais visual e ficam melhor ali).
- Alcance da fonte: nunca apresente como regra geral o que vale para um anexo ou setor específico. Na resposta curta e em "Como decidir", diga o alcance em palavras simples, sem nome de norma, anexo ou número de item (ex.: "uma regra do Ministério do Trabalho para postos de atendimento por telefone usa como referência..."); o nome técnico ("Anexo II da NR-17") fica só nas seções de detalhe.
- Termo técnico na resposta curta e em "Como decidir" (nome de mecanismo, "antropométrico", sigla de norma): troque pela descrição do que ele faz ("encosto que inclina sozinho"); se for inevitável, explique entre parênteses na mesma frase. "É preferível" ou "recomenda" (manual, guia) não é "exige". Se houver duas versões do mesmo documento, use a mais recente.
- Escreva para ${n.audience}: resposta curta e "Como decidir" falam com quem vai comprar (não com empregador, fiscal ou fabricante). Norma ou regulador servem de referência ("a norma usa X como referência"), não de obrigação do leitor. Se a página cita mais de um fabricante, "Como decidir" não se apoia numa marca só.
- A seção "Como decidir" aparece no TOPO da página, logo depois da resposta curta, para quem não entende do assunto: frases curtas, palavras do dia a dia, termo técnico só com explicação entre parênteses, cada orientação começando por "Se você..." e dizendo o que conferir. Os detalhes técnicos ficam nas outras seções.
- Títulos de seção em forma de pergunta do leitor quando couber ("Qual altura escolher para quem dorme de lado?"), como as pessoas perguntam ao Google.
- Formatos que ajudam o leigo (pesquisa de 21/10 em Sleep Foundation, Consumer Reports e mybest), só quando as evidências sustentam cada item: tabela de decisão por perfil (perfil × o que conferir), "para quem é / para quem não é" de cada opção, checklist do que conferir na ficha antes de comprar. Nunca nota, ranking ou preço.
- Use uma tabela comparativa só se as evidências permitirem preencher TODAS as células; coluna ou linha sem evidência não entra na tabela (o site não publica "não informado nas fontes" nem "confira na ficha" como célula: o gate recusa).${writerLessons()}`;
}

// Qual documento é (título + endereço): é aí que aparece o alcance ("anexo II teleatendimento") e a versão
// ("atualizada-2018"). Sem isto, regra de um anexo virou "a NR-17 exige" para toda cadeira (21/10).
// Com o trecho, diz também em que parte do documento ele está (último "ANEXO II"/"CAPÍTULO 3" antes dele,
// com a linha de título seguinte): o PDF inteiro da NR-17 traz o Anexo II, e pelo endereço não dava para saber.
export function docLabel(s: Source | undefined, quote?: string): string {
  if (!s) return '?';
  const where = quote ? quoteLocation(s, quote) : null;
  return `${s.title ? `"${s.title.slice(0, 100)}" ` : ''}${s.final_url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 160)}${where ? ` | trecho em: ${where}` : ''}`;
}

const PART = /^[^\p{L}\d]*((?:ANEXO|Anexo|CAPÍTULO|Capítulo|CAPITULO)\s+[IVXLC\d]+\b[^\n]{0,80})$/gmu;
export function quoteLocation(s: Source, quote: string): string | null {
  const text = sourceText(s.id);
  if (!text) return null;
  const i = text.indexOf(quote.slice(0, 40));
  if (i < 0) return null;
  let last: RegExpExecArray | null = null;
  for (const m of text.slice(0, i).matchAll(PART)) last = m;
  // Antes de qualquer anexo/capítulo, mas o documento tem anexos depois: é o texto principal (21/10: o
  // redator pôs "no Anexo II" no objetivo geral da NR-17). Título que reaparece depois do trecho é sumário.
  const after = [...text.slice(i).matchAll(PART)];
  const key = (h: string) => /^(\S+)\s+([IVXLC\d]+)/i.exec(h.trim())?.slice(1).join(' ').toUpperCase().replace('Í', 'I');
  if (last && after.some((m) => key(m[1]!) === key(last![1]!))) last = null;
  if (!last) return after.length ? `texto principal (antes de ${after[0]![1]!.trim().slice(0, 40)})` : null;
  const head = last[1]!.trim();
  // "ANEXO II" sozinho: a linha seguinte costuma ser o título ("TRABALHO EM TELEATENDIMENTO/TELEMARKETING").
  const next = head.length < 20 ? text.slice(last.index! + last[0].length, i).split('\n').map((l) => l.trim()).find((l) => l.length > 3) : undefined;
  return `${head}${next ? ` · ${next.slice(0, 80)}` : ''}`;
}

// Alcance da evidência, dito ao redator em cada uma (27/10: o solteirão foi reescrito 2 vezes e as 2 pararam na
// coerência porque a medida e o peso de UM modelo da Probel viraram "o solteirão mede/suporta"; o redator recebia
// ~150 evidências sem saber qual era ficha de produto e qual era regra). Dado técnico ou disponibilidade vindo de
// fabricante vale só para aquele produto; norma e regulador valem em geral; o resto é posição da marca.
export function claimScope(c: Pick<Claim, 'claim_type' | 'scope'>, s: Pick<Source, 'source_class'> | undefined): string {
  // Decidido na extração quando existe (evidências a partir de 27/10); senão, deduzido pelo tipo e pela classe.
  if (c.scope === 'produto') return 'SÓ O PRODUTO deste documento: escreva com o nome do modelo ("no X da Marca, …"), nunca como medida ou capacidade do tamanho, do tipo ou da categoria';
  if (c.scope === 'marca') return 'guia ou tabela da marca sobre seus produtos em geral: vale para os tamanhos ou tipos que a marca lista ("segundo a Marca, o solteiro king mede…")';
  if (c.scope === 'geral') return 'regra geral (norma ou regulador)';
  if (s?.source_class === 'regulator' || s?.source_class === 'standard_body' || c.claim_type === 'regulation') return 'regra geral (norma ou regulador)';
  if (s?.source_class === 'manufacturer' && (c.claim_type === 'spec' || c.claim_type === 'availability')) return 'SÓ O PRODUTO deste documento: escreva com o nome do modelo ("no X da Marca, …"), nunca como medida ou capacidade do tamanho, do tipo ou da categoria';
  if (s?.source_class === 'manufacturer') return 'posição da marca ("segundo a Marca")';
  return 'posição desta fonte ("segundo <fonte>")';
}

export function formatClaims(claims: Claim[], sources: Map<string, Source>): string {
  return claims
    .map((c) => {
      const s = sources.get(c.source_id);
      return `[${c.id}] fonte: ${s?.publisher ?? '?'} (${s?.source_class ?? '?'}) | documento: ${docLabel(s, c.quote)} | tipo: ${c.claim_type} | alcance: ${claimScope(c, s)}\n  paráfrase: ${c.statement}\n  trecho literal: "${c.quote}"`;
    })
    .join('\n');
}

// Modelos à venda no catálogo para os tipos da pauta: quando a página compara modelos, compara os que o leitor
// consegue comprar (22/10: a cadeira comparava a Cavaletti Diretor, que não está à venda, e os exemplos
// à venda eram outros modelos, que o texto nunca citava).
export function catalogNote(topic: TopicBrief): string {
  const list = loadProducts().filter((p) => topic.product_kinds.includes(p.kind));
  if (!list.length) return '';
  return `\nModelos à venda no catálogo do site (${list.length}): ${list.map((p) => `${p.brand}: ${p.label}`).join(' | ')}.\nAo comparar modelos, prefira os destes fabricantes quando houver evidência deles; modelo citado que não está à venda não serve de exemplo de compra. Uma coluna de tabela é um modelo só.\n`;
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
    catalogNote(topic) +
    examplesPrompt('writer', { pageType: topic.page_type, exclude: topic.slug }) +
    `\nEvidências disponíveis (${claims.length}):\n${formatClaims(claims, sources)}`;
  const user = fix
    ? `${brief}\n\nVocê já escreveu o rascunho abaixo, mas ele tem problemas. Corrija TODOS os problemas listados, mexendo só no necessário (pode reescrever, encolher ou remover o bloco). Devolva o rascunho completo corrigido.\n\nProblemas:\n${fix.issues.map((i) => `- ${i}`).join('\n')}\n\nRascunho anterior:\n${JSON.stringify(fix.previous)}`
    : brief;
  return callJson({ role: 'writer', system: writerSystem(), user, schema, schemaName: 'page_draft', maxTokens: 16000 }, fetchImpl);
}
