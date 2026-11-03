import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SearchLinks, searchLinkProblem, type PageSpec } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { MODELS } from '../models.ts';
import { loadNiche } from '../niche.ts';
import { DATA, loadTopics, writeJson } from '../store.ts';

// Buscas na Amazon para páginas no ar que ainda não têm (link com a nossa tag; nada a ler na Amazon).
// O modelo barato traduz os critérios do "Como decidir" em 1 a 3 buscas; o código valida e grava.

export const SEARCH_LINKS_FILE = join(DATA, 'search-links.json');

export function loadSearchLinks(): SearchLinks {
  return existsSync(SEARCH_LINKS_FILE) ? SearchLinks.parse(JSON.parse(readFileSync(SEARCH_LINKS_FILE, 'utf8'))) : SearchLinks.parse({});
}

const Out = z.object({ links: z.array(z.object({ label: z.string(), query: z.string() })) });

const SYSTEM = `Você cria buscas na Amazon Brasil para um guia de compra. O leitor é leigo, acabou de ler o resumo do guia e quer ver opções.
Devolva de 1 a 3 buscas, cada uma para uma ESCOLHA diferente que o guia ensina a fazer (em página que compara tipos, uma por tipo; senão, pelos critérios principais: tipo, tamanho, firmeza, regulagem).
- "query": como um consumidor comum digita na Amazon: o produto + 1 ou 2 características de escolha (2 a 5 palavras, minúsculas, sem marca). Ex.: "colchão espuma d33 casal", "cadeira escritório apoio de braço regulável", "travesseiro alto firme".
- "label": o que o leitor vai encontrar, em palavras do dia a dia, sem termo técnico (ex.: "Cadeiras com braço e altura reguláveis").
Nunca use: jargão (nome de mecanismo, norma, "antropométrico"), instrução de lavagem, medida exata em cm a não ser tamanho padrão de cama, "melhor", "top", "barato", "oferta", promessa de saúde ou de resultado.`;

// Público ou uso de saúde que a página não menciona não entra na busca. 03/11, travesseiro de corpo: o gerador
// criou "Travesseiro de corpo para grávidas" numa página com ZERO menções a gravidez. A busca é o último clique
// antes da compra; prometer uso que a página não sustenta é afirmação sem fonte, só que dentro de um link -- o
// ponto cego registrado em DECISIONS (29/10): os portões leem texto, não destino de link.
const PUBLICO = /\b(gr[aá]vid\w*|gestante\w*|gravidez|idos[oa]s?|crian[cç]as?|beb[eê]s?|infantil|dor(es)?|coluna|postura|lombar|cervical|al[eé]rgic\w*|alergia|ortop[eé]dic\w*|terap[eê]utic\w*|hernia|h[eé]rnia)\b/giu;
const semAcento = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function textoDaPagina(p: PageSpec): string {
  return semAcento([p.title, p.verdict.text, ...p.sections.flatMap((x) => [x.heading, ...x.blocks.map((b) => (b.kind === 'table' ? [b.caption, ...b.columns, ...b.rows.flatMap((r) => r.cells.map((c) => c.text))].join(' ') : b.text))])].join(' '));
}
export function publicoQueAPaginaNaoTem(l: { label: string; query: string }, texto: string): boolean {
  // Palavra curta exige a palavra inteira ("dor" é pedaço de "dormir", que está em toda página de travesseiro);
  // palavra longa aceita a raiz (gravidez/grávida, coluna/colunas).
  return [...`${l.label} ${l.query}`.matchAll(PUBLICO)].some((m) => {
    const w = semAcento(m[0]);
    return w.length <= 5 ? !new RegExp(`\\b${w}\\b`).test(texto) : !texto.includes(w.slice(0, 5));
  });
}

export async function ensureSearchLinks(pages: PageSpec[], fetchImpl?: FetchLike, max = 5, now = new Date()): Promise<string[]> {
  const data = loadSearchLinks();
  const forbidden = loadNiche().forbidden_terms;
  const todo = pages.filter((p) => p.status !== 'draft' && !data.pages[p.slug]).slice(0, max);
  for (const p of todo) {
    const decide = p.sections.findLast((s) => /decidir|escolher/i.test(`${s.id} ${s.heading}`)) ?? p.sections.at(-1)!;
    const r = await callJson(
      {
        role: 'extractor',
        system: SYSTEM,
        user: `Guia: ${p.title}\nResposta curta: ${p.verdict.text}\n${decide.heading}:\n${decide.blocks.map((b) => (b.kind === 'table' ? '' : `- ${b.text}`)).join('\n')}`,
        schema: Out,
        schemaName: 'amazon_searches',
        maxTokens: 400,
      },
      fetchImpl,
    );
    const links = r.data.links
      .map((l) => ({ label: l.label.trim().replace(/\s+/g, ' '), query: l.query.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b(\p{L}+)( \1\b)+/gu, '$1') }))
      .filter((l) => !searchLinkProblem(l, forbidden))
      .filter((l) => !publicoQueAPaginaNaoTem(l, textoDaPagina(p)))
      .slice(0, 3);
    // Nenhuma busca válida: o tipo de produto da própria página (sempre existe e nunca é promessa).
    if (!links.length) {
      const kinds = loadTopics().find((t) => t.slug === p.slug)?.product_kinds ?? [];
      const labels = loadNiche().product_kinds.filter((k) => kinds.includes(k.id) && k.id !== 'outro').map((k) => k.label);
      for (const l of labels.slice(0, 3)) links.push({ label: `${l}: ver opções`, query: l.toLowerCase() });
    }
    data.pages[p.slug] = { links, model: MODELS.extractor.id, at: now.toISOString() };
  }
  if (todo.length) writeJson(SEARCH_LINKS_FILE, data);
  return todo.map((p) => p.slug);
}
