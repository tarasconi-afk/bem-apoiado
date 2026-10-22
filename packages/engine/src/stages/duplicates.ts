import { normalizeForMatch } from '@bem-apoiado/core';
import type { Draft } from './draft-schema.ts';

// Parágrafos repetidos na mesma página (22/10: o parágrafo do Inmetro aparecia duas vezes na firme ou macio).
// Determinístico: palavras de 4+ letras, sobreposição sobre o MENOR bloco (o curto dentro do longo também é
// repetição). Só blocos de texto com 8+ palavras; o repetido é sempre o que vem depois.
const STOP = new Set(['segundo', 'sobre', 'para', 'como', 'mais', 'menos', 'pela', 'pelo', 'pelas', 'pelos', 'entre', 'quando', 'também', 'essa', 'esse', 'este', 'esta', 'cada', 'seus', 'suas', 'deve', 'pode', 'podem', 'devem']);
const words = (t: string) => new Set(normalizeForMatch(t).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));

export const DUPLICATE_MIN_OVERLAP = 0.8;

export function duplicateBlocks(d: Draft, min = DUPLICATE_MIN_OVERLAP): { ref: string; of: string; overlap: number }[] {
  const lastId = d.sections.at(-1)?.id ?? '';
  const units: { ref: string; w: Set<string> }[] = [];
  for (const s of d.sections) s.blocks.forEach((b, i) => { if (b.kind !== 'table') units.push({ ref: `${s.id}#${i}`, w: words(b.text) }); });
  const out: { ref: string; of: string; overlap: number }[] = [];
  for (let j = 0; j < units.length; j++) {
    const b = units[j]!;
    if (b.w.size < 8 || out.some((o) => o.ref === b.ref)) continue;
    for (let i = 0; i < j; i++) {
      const a = units[i]!;
      if (a.w.size < 8 || out.some((o) => o.ref === a.ref)) continue;
      const inter = [...b.w].filter((x) => a.w.has(x)).length;
      const overlap = inter / Math.min(a.w.size, b.w.size);
      if (overlap >= min) {
        // O "Como decidir" (última seção) aparece no topo da página: quando a repetição cruza decisão e
        // detalhe, sai a cópia do detalhe; dentro da mesma seção, sai a que vem depois.
        const cutA = b.ref.startsWith(`${lastId}#`) && !a.ref.startsWith(`${lastId}#`);
        out.push(cutA ? { ref: a.ref, of: b.ref, overlap: Math.round(overlap * 100) / 100 } : { ref: b.ref, of: a.ref, overlap: Math.round(overlap * 100) / 100 });
        break;
      }
    }
  }
  return out;
}

// Remove os blocos repetidos de uma página (só remoção: não cria afirmação nova, nada a auditar). Mantém a
// página com 3+ seções; se a remoção tirar demais, não remove.
export function withoutDuplicates(d: Draft): { draft: Draft; removed: string[] } {
  const dups = duplicateBlocks(d);
  if (!dups.length) return { draft: d, removed: [] };
  const cut = new Set(dups.map((x) => x.ref));
  const out: Draft = structuredClone(d);
  out.sections = out.sections.map((s) => ({ ...s, blocks: s.blocks.filter((_, i) => !cut.has(`${s.id}#${i}`)) })).filter((s) => s.blocks.length > 0);
  if (out.sections.length < 3) return { draft: d, removed: [] };
  return { draft: out, removed: [...cut] };
}
