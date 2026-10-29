import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeForMatch } from '@bem-apoiado/core';
import { DATA, writeJson } from '../store.ts';
import { loadNiche } from '../niche.ts';

// Modelos que cada página no ar cita pelo nome (gravados pela busca de modelos citados da manutenção). O site usa
// para o link "Ver <marca> <modelo> na Amazon" quando o catálogo não tem anúncio aceito do modelo (editor, 26/10:
// "sim" ao link pelo nome). É busca, não recomendação: a linha do fabricante pode ter várias versões (o Guarda
// Costas da Probel vai de D20 a D33 conforme a altura), e o leitor confere a versão na ficha.

export const CITED_MODELS_FILE = join(DATA, 'cited-models.json');
export const MAX_CITED_LINKS = 3;

const Model = z.object({ brand: z.string().min(2), model: z.string().min(2), kind: z.string() });
export const CitedModels = z.object({ pages: z.record(z.string(), z.object({ models: z.array(Model), at: z.string() })).default({}) });
export type CitedModels = z.infer<typeof CitedModels>;

export function loadCitedModels(): CitedModels {
  return existsSync(CITED_MODELS_FILE) ? CitedModels.parse(JSON.parse(readFileSync(CITED_MODELS_FILE, 'utf8'))) : CitedModels.parse({});
}

export function saveCitedModels(slug: string, models: z.infer<typeof Model>[], now = new Date()): void {
  const all = loadCitedModels();
  all.pages[slug] = { models, at: now.toISOString() };
  writeJson(CITED_MODELS_FILE, all);
}

const loose = (t: string) => normalizeForMatch(t).replace(/-/g, ' ');

// O catálogo já tem este modelo (mesma marca e o nome do modelo no rótulo)?
export function inCatalog(m: { brand: string; model: string }, products: { brand: string; label: string }[]): boolean {
  const tokens = loose(m.model).split(/\s+/).filter((t) => t.length >= 3);
  return products.some((p) => loose(p.brand) === loose(m.brand) && tokens.length > 0 && tokens.every((t) => loose(p.label).includes(t)));
}

// Medida e tipo não são nome de modelo: "Excede Premium Casal" vira "Excede Premium"; "Pillow Top" e "Box Baú"
// sozinhos (linha da marca, leitura de 26/10 na altura do colchão) não geram link.
const SIZE = new Set(['solteiro', 'solteirao', 'viuva', 'casal', 'queen', 'king', 'size', 'super']);
const GENERIC = new Set([...SIZE, 'pillow', 'top', 'box', 'bau', 'colchao', 'travesseiro', 'base', 'cama', 'espuma', 'molas', 'mola', 'ensacadas', 'ensacada', 'premium', 'plus']);
export function modelName(model: string): string | null {
  const words = model.trim().split(/\s+/).filter((w) => !SIZE.has(loose(w)));
  return words.length && !words.every((w) => GENERIC.has(loose(w))) ? words.join(' ') : null;
}

// Links de busca pelo nome para os modelos citados sem anúncio aceito no catálogo (no máximo 3, na ordem do texto).
// 29/10, guia da toalha: "Ver Sultan Max na Amazon" caía numa lista de PERFUMES. O tipo do produto estava
// gravado no modelo citado (kind: "toalha") e simplesmente não entrava na busca, então marca + modelo iam
// soltos para a Amazon e o acaso decidia a categoria. Com o tipo, a busca cai onde o guia fala.
export function citedSearchLinks(slug: string, products: { brand: string; label: string }[], cited = loadCitedModels()): { label: string; query: string }[] {
  const seen = new Set<string>();
  // Sem nicho legível (instalação nova, teste), o próprio id do tipo já serve de palavra de busca.
  let rotulo = new Map<string, string>();
  try { rotulo = new Map(loadNiche().product_kinds.map((k) => [k.id, k.label])); } catch { /* usa o id */ }
  return (cited.pages[slug]?.models ?? [])
    .filter((m) => !inCatalog(m, products))
    .flatMap((m) => {
      const name = modelName(m.model);
      if (!name) return [];
      // Nome que já diz o tipo ("Teka Toalha Monaco") não repete a palavra na busca.
      // Só o substantivo do rótulo ("Colchão de molas ensacadas" -> "Colchão"): a palavra inteira estreitaria
      // a busca a ponto de não sobrar anúncio, e uma só já resolve a categoria.
      const tipo = (rotulo.get(m.kind) ?? m.kind).split(/\s+/)[0]!;
      const jaTem = loose(tipo).split(/\s+/).every((w) => loose(`${m.brand} ${name}`).includes(w));
      return [{ label: `Ver ${m.brand} ${name} na Amazon`, query: jaTem ? `${m.brand} ${name}` : `${m.brand} ${name} ${tipo}` }];
    })
    .filter((l) => !seen.has(loose(l.query)) && seen.add(loose(l.query)))
    .slice(0, MAX_CITED_LINKS);
}
