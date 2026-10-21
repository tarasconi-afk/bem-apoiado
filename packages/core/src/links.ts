import { z } from 'zod';
import type { PageSpec } from './schemas.ts';

// Links internos no texto (data/link-anchors.json). Cada página no ar tem de 3 a 6 expressões-âncora
// ("molas ensacadas", "densidade da espuma"); o site liga a PRIMEIRA ocorrência delas no texto das outras
// páginas. O texto não muda (nada a re-auditar): só ganha um link onde a expressão já está escrita.
// Limites para não virar texto azul: 1 link por destino, 1 por bloco, MAX_LINKS por página; resposta curta
// e tabelas ficam sem link.

export const LinkAnchors = z.object({
  pages: z.record(z.string(), z.object({ anchors: z.array(z.string()), model: z.string(), at: z.string() })).default({}),
});
export type LinkAnchors = z.infer<typeof LinkAnchors>;

export const MAX_LINKS = 4;

export interface PlacedLink { start: number; end: number; slug: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anchorRe = (a: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(a).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');

// Âncora aceitável: 1 a 4 palavras, sem pontuação de frase, nem só o nome-base do produto ("colchão"),
// que aparece em toda página e ligaria qualquer coisa a qualquer coisa.
export function validAnchor(a: string, bareNouns: string[]): boolean {
  const t = a.trim();
  const words = t.split(/\s+/);
  if (t.length < 3 || t.length > 40 || words.length > 4 || /[.,;:!?"“”()]/.test(t)) return false;
  return !bareNouns.some((n) => n.toLowerCase() === t.toLowerCase());
}

// Onde ligar, por bloco ("secao#indice"), na ordem do texto. targets: páginas no ar, exceto a própria.
export function placeLinks(page: Pick<PageSpec, 'slug' | 'sections'>, targets: { slug: string; anchors: string[] }[], max = MAX_LINKS): Map<string, PlacedLink> {
  const out = new Map<string, PlacedLink>();
  const used = new Set<string>();
  const cands = targets
    .filter((t) => t.slug !== page.slug)
    .flatMap((t) => t.anchors.map((a) => ({ slug: t.slug, a, re: anchorRe(a) })))
    .sort((x, y) => y.a.length - x.a.length); // a mais específica ganha no mesmo lugar
  for (const s of page.sections) {
    for (const [i, b] of s.blocks.entries()) {
      if (out.size >= max) return out;
      if (b.kind === 'table') continue;
      let best: PlacedLink | undefined;
      for (const c of cands) {
        if (used.has(c.slug)) continue;
        const m = c.re.exec(b.text);
        if (m && (!best || m.index < best.start)) best = { start: m.index, end: m.index + m[0].length, slug: c.slug };
      }
      if (best) {
        out.set(`${s.id}#${i}`, best);
        used.add(best.slug);
      }
    }
  }
  return out;
}
