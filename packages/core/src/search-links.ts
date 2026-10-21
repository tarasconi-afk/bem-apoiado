import { z } from 'zod';
import { firstForbidden } from './text.ts';

// Buscas na Amazon por página (data/search-links.json): de 1 a 3, com rótulo em linguagem do leitor e termo
// de busca vindo dos critérios do "Como decidir". Gerado uma vez por página (modelo barato), auditável.
export const SearchLinks = z.object({
  pages: z.record(z.string(), z.object({ links: z.array(z.object({ label: z.string(), query: z.string() })), model: z.string(), at: z.string() })).default({}),
});
export type SearchLinks = z.infer<typeof SearchLinks>;

// Sem promessa nem ranking no rótulo ou no termo ("melhor", "top", "oferta"), sem termo vetado do nicho.
const PROMO = /\b(melhor(es)?|top|barat[oa]s?|promo[cç][aã]o|oferta|mais vendid[oa]s?|imperd[ií]vel|desconto|premium|luxo)\b/i;
export function searchLinkProblem(l: { label: string; query: string }, forbidden: string[]): string | null {
  const q = l.query.trim();
  const words = q.split(/\s+/);
  if (words.length < 2 || words.length > 7 || q.length > 60) return 'termo de busca precisa ter de 2 a 7 palavras';
  if (l.label.trim().length < 8 || l.label.length > 70) return 'rótulo precisa ter de 8 a 70 caracteres';
  if (PROMO.test(q) || PROMO.test(l.label)) return 'promoção ou ranking no rótulo ou no termo';
  if ((q.match(/\d+\s*x\s*\d+/gi) ?? []).length > 1) return 'mais de uma medida no mesmo termo';
  if (firstForbidden(`${l.label} ${q}`, forbidden)) return 'termo vetado pelo nicho';
  return null;
}
