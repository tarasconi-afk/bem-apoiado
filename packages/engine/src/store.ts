import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Claim, PageSpec, Product, Source, TopicBrief, type EvidenceIndex } from '@bem-apoiado/core';

// Raiz achada subindo a partir do cwd: import.meta.url não serve quando o Astro empacota este módulo.
function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'bem-apoiado') return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`raiz do projeto bem-apoiado não encontrada a partir de ${start}`);
    dir = parent;
  }
}

// Tudo que é editorial ou evidência vive em data/, versionado no git. Nada em /tmp.
export const ROOT = process.env.BEM_ROOT ?? findRoot(process.cwd());
export const DATA = join(ROOT, 'data');
export const SOURCES_DIR = join(DATA, 'sources');
export const CLAIMS_DIR = join(DATA, 'claims');
export const PAGES_DIR = join(DATA, 'pages');
export const RUNS_DIR = join(DATA, 'runs');
export const PRODUCTS_DIR = join(DATA, 'products');
export const TOPICS_DIR = join(DATA, 'topics');

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function readJsonDir<T>(dir: string, parse: (v: unknown) => T): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      try {
        return parse(raw);
      } catch (e) {
        throw new Error(`${join(dir, f)}: ${(e as Error).message}`);
      }
    });
}

export function loadSources(): Source[] {
  if (!existsSync(SOURCES_DIR)) return [];
  return readdirSync(SOURCES_DIR)
    .filter((d) => existsSync(join(SOURCES_DIR, d, 'meta.json')))
    .sort()
    .map((d) => Source.parse(JSON.parse(readFileSync(join(SOURCES_DIR, d, 'meta.json'), 'utf8'))));
}

export const loadClaims = () => readJsonDir(CLAIMS_DIR, (v) => Claim.parse(v));
export const loadPages = () => readJsonDir(PAGES_DIR, (v) => PageSpec.parse(v));
export const loadProducts = () => readJsonDir(PRODUCTS_DIR, (v) => Product.parse(v));
export const loadTopics = () => readJsonDir(TOPICS_DIR, (v) => TopicBrief.parse(v));

export function sourceText(sourceId: string): string | undefined {
  const p = join(SOURCES_DIR, sourceId, 'text.txt');
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export function buildIndex(): EvidenceIndex {
  return {
    claims: new Map(loadClaims().map((c) => [c.id, c])),
    sources: new Map(loadSources().map((s) => [s.id, s])),
    sourceText,
  };
}
