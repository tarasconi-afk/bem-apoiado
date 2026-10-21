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
