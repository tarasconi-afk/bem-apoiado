import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LinkAnchors, validAnchor, type PageSpec } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { MODELS } from '../models.ts';
import { loadNiche } from '../niche.ts';
import { DATA, writeJson } from '../store.ts';

// Âncoras dos links internos: para cada página no ar, o modelo barato propõe as expressões curtas com que
// OUTRAS páginas se refeririam ao assunto dela. A colocação no texto é do site (placeLinks, determinística).
// Cada âncora pertence a uma página só: a primeira que a reivindicou fica com ela.

export const LINK_ANCHORS_FILE = join(DATA, 'link-anchors.json');

export function loadAnchors(): LinkAnchors {
  return existsSync(LINK_ANCHORS_FILE) ? LinkAnchors.parse(JSON.parse(readFileSync(LINK_ANCHORS_FILE, 'utf8'))) : LinkAnchors.parse({});
}

export function bareNouns(): string[] {
  const base = loadNiche().product_kinds.map((k) => k.label.toLowerCase().split(' de ')[0]!.trim());
  return [...new Set(base.flatMap((b) => [b, b.endsWith('ão') ? b.slice(0, -2) + 'ões' : b + 's']))];
}

const Out = z.object({ anchors: z.array(z.string()) });

const SYSTEM = `Você escolhe âncoras de link interno para um site de guias de compra em português do Brasil.
Dada uma página, devolva de 3 a 6 expressões CURTAS (1 a 4 palavras, minúsculas) que outras páginas do site escreveriam no meio do texto ao falar do assunto desta página, e que um leitor clicaria esperando chegar nela.
Regras: só o assunto PRINCIPAL da página, o que a busca principal pergunta; nunca um subtema de uma seção (lavagem, garantia, etiqueta, peso), que terá página própria. Ex.: "colchão D28 ou D33" → "densidade do colchão", "colchão d33"; "como escolher travesseiro" → "escolher o travesseiro", "tipos de travesseiro". Expressões que aparecem naturalmente em prosa; inclua variações de singular/plural quando forem comuns; nada genérico demais (só o nome do produto, "conforto", "qualidade"); nada de marca; sem pontuação.`;

export async function ensureAnchors(pages: PageSpec[], fetchImpl?: FetchLike, max = 5, now = new Date()): Promise<string[]> {
  const data = loadAnchors();
  const nouns = bareNouns();
  const todo = pages.filter((p) => p.status !== 'draft' && !data.pages[p.slug]).slice(0, max);
  for (const p of todo) {
    const r = await callJson(
      {
        role: 'extractor',
        system: SYSTEM,
        user: `Busca principal: "${p.primary_query}"\nTítulo: ${p.title}\nSeções: ${p.sections.map((s) => s.heading).join(' | ')}`,
        schema: Out,
        schemaName: 'link_anchors',
        maxTokens: 300,
      },
      fetchImpl,
    );
    const taken = new Set(Object.values(data.pages).flatMap((x) => x.anchors.map((a) => a.toLowerCase())));
    const anchors = [...new Set(r.data.anchors.map((a) => a.trim().toLowerCase().replace(/\s+/g, ' ')))]
      .filter((a) => validAnchor(a, nouns) && !taken.has(a))
      .slice(0, 6);
    data.pages[p.slug] = { anchors, model: MODELS.extractor.id, at: now.toISOString() };
  }
  if (todo.length) writeJson(LINK_ANCHORS_FILE, data);
  return todo.map((p) => p.slug);
}
