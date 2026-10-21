import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { affiliateUrl, amazonSearchUrl, checkProduct, DEFAULT_THEME, placeLinks, Theme, referencedClaimIds, type Claim, type PageSpec, type Product, type Source } from '@bem-apoiado/core';
import { buildIndex, loadAnchors, loadClaims, loadSearchLinks, loadImageRegistry, loadNiche, loadPages, loadProducts, loadSources, loadTopics, ROOT, SEARCH_INDEX_NOTE } from '@bem-apoiado/engine';

// Indexação só é liberada com SITE_INDEXABLE=true explícito no ambiente de deploy.
export const INDEXABLE = process.env.SITE_INDEXABLE === 'true';

// Marca, textos e vocabulário de produtos vêm do perfil de nicho (data/niche.json).
export const NICHE = loadNiche();
export const BRAND = NICHE.brand;

// Só páginas aprovadas e auditadas vão ao ar. Rascunhos aparecem apenas com SITE_SHOW_DRAFTS=true (preview).
export function publicPages(): PageSpec[] {
  const showDrafts = process.env.SITE_SHOW_DRAFTS === 'true';
  return loadPages().filter((p) => p.status !== 'draft' || showDrafts);
}

// Fontes agrupadas por documento: o número da citação aponta para a fonte, e cada fonte lista
// os trechos literais que a página usou dela.
export interface SourceNote {
  n: number;
  source: Source;
  claims: Claim[];
}

export interface Footnotes {
  notes: SourceNote[];
  numberFor: (claimIds: string[]) => number[];
}

export function footnotesFor(page: PageSpec): Footnotes {
  const claims = new Map(loadClaims().map((c) => [c.id, c]));
  const sources = new Map(loadSources().map((s) => [s.id, s]));
  const bySource = new Map<string, SourceNote>();
  for (const id of referencedClaimIds(page)) {
    const c = claims.get(id);
    const s = c ? sources.get(c.source_id) : undefined;
    if (!c || !s) continue;
    if (!bySource.has(s.id)) bySource.set(s.id, { n: bySource.size + 1, source: s, claims: [] });
    bySource.get(s.id)!.claims.push(c);
  }
  return {
    notes: [...bySource.values()],
    numberFor: (ids) =>
      [...new Set(ids.map((id) => bySource.get(claims.get(id)?.source_id ?? '')?.n).filter((n): n is number => !!n))].sort(
        (a, b) => a - b,
      ),
  };
}

export function readingMinutes(page: PageSpec): number {
  let words = page.verdict.text.split(/\s+/).length;
  for (const s of page.sections)
    for (const b of s.blocks)
      words += b.kind === 'table' ? b.rows.flatMap((r) => r.cells.map((c) => c.text)).join(' ').split(/\s+/).length / 2 : b.text.split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

export const KIND_LABEL: Record<string, string> = Object.fromEntries(NICHE.product_kinds.map((k) => [k.id, k.label]));

export interface ProductCard {
  product: Product;
  url: string;
  specs: { statement: string; sourceUrl: string; publisher: string }[];
  // Nível "só anúncio": trecho literal do anúncio que descreve o tipo (quem afirma é o vendedor).
  listingQuote: string | null;
  checkedAt: string;
  // Prova só pelo índice de busca (página do anúncio bloqueada): o cartão não afirma disponibilidade.
  searchOnly: boolean;
  // Escolhido pelo editor (link colado no painel): o cartão diz isso e manda conferir preço e estoque.
  editorPick: boolean;
}

// Exemplos à venda: só tipos que a pauta explica, só produtos que passam no gate agora (ficha do
// fabricante + anúncio do mesmo ASIN capturado há menos de 30 dias). Sem ordem de preferência.
export function productsFor(page: PageSpec): ProductCard[] {
  const topic = loadTopics().find((t) => t.slug === page.slug);
  if (!topic || topic.product_kinds.length === 0) return [];
  const idx = buildIndex();
  return loadProducts()
    .filter((p) => topic.product_kinds.includes(p.kind) && checkProduct(p, idx, new Date(), KIND_LABEL[p.kind], NICHE.forbidden_terms).length === 0)
    // Com ficha oficial antes de "só anúncio" e da escolha do editor.
    .sort((a, b) => (a.evidence === b.evidence ? 0 : a.evidence === 'manufacturer' ? -1 : b.evidence === 'manufacturer' ? 1 : 0))
    .sort((a, b) => topic.product_kinds.indexOf(a.kind) - topic.product_kinds.indexOf(b.kind) || a.label.localeCompare(b.label))
    .map((p) => ({
      product: p,
      url: affiliateUrl(p.asin),
      specs: p.spec_claim_ids.map((id) => {
        const c = idx.claims.get(id)!;
        const s = idx.sources.get(c.source_id)!;
        return { statement: c.quote, sourceUrl: s.final_url, publisher: s.publisher };
      }),
      listingQuote: p.evidence === 'listing' ? idx.claims.get(p.availability_claim_id!)!.quote : null,
      checkedAt: p.evidence === 'editor' ? p.editor!.checked_at : idx.claims.get(p.availability_claim_id!)!.captured_at,
      searchOnly: p.evidence !== 'editor' && idx.sources.get(idx.claims.get(p.availability_claim_id!)!.source_id)?.note === SEARCH_INDEX_NOTE,
      editorPick: p.evidence === 'editor',
    }));
}

// Tipos que a página explica (para as ilustrações). "outro" não tem desenho próprio.
export function kindsFor(page: PageSpec): string[] {
  const topic = loadTopics().find((t) => t.slug === page.slug);
  return (topic?.product_kinds ?? []).filter((k) => k !== 'outro');
}

// Imagem de cada cartão da home: a capa própria da página (gerada no ciclo) ou, enquanto ela não
// existe, o primeiro tipo da página que nenhum cartão anterior usou. A home nunca repete imagem.
export function homeIllustrations(pages: PageSpec[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const p of pages) {
    const cover = `pagina-${p.slug}`;
    const k = IMAGES.some((r) => r.id === cover) ? cover : (kindsFor(p).find((x) => !used.has(x)) ?? kindsFor(p)[0] ?? 'outro');
    used.add(k);
    out.set(p.slug, k);
  }
  return out;
}

export const sourcesCount = (page: PageSpec) => footnotesFor(page).notes.length;

// Imagens ilustrativas (IA) registradas em data/images/registry.json, por id ou tipo de produto.
const IMAGES = loadImageRegistry(ROOT);
export const imageFor = (idOrKind: string) => IMAGES.find((r) => r.id === idOrKind) ?? IMAGES.find((r) => r.kind === idOrKind);

// Links internos respeitam o caminho-base do build (a prévia de ramo no painel vive em /painel/previa/<ramo>/).
export const href = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;

// Ordem dos guias na home: a do Search Console (data/home-order.json, gravada pelo ciclo) quando existe;
// páginas fora dela vêm depois, das mais novas para as mais antigas.
export function homeSorted(pages: PageSpec[]): PageSpec[] {
  const f = join(ROOT, 'data/home-order.json');
  const order: string[] = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).order : [];
  const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  return [...pages].sort((a, b) => rank(a.slug) - rank(b.slug) || b.updated_at.localeCompare(a.updated_at));
}

// Categoria de cada página: a primeira categoria do nicho que contém um dos tipos da pauta.
export const CATEGORIES = NICHE.categories;
export function categoryOf(page: PageSpec): (typeof CATEGORIES)[number] | undefined {
  const kinds = loadTopics().find((t) => t.slug === page.slug)?.product_kinds ?? [];
  return CATEGORIES.find((c) => c.kinds.some((k) => kinds.includes(k)));
}

// Guias relacionados: mesma categoria primeiro (mais tipos em comum antes), depois os demais; nunca a própria.
export function relatedPages(page: PageSpec, max = 4): PageSpec[] {
  const kinds = new Set(loadTopics().find((t) => t.slug === page.slug)?.product_kinds ?? []);
  const cat = categoryOf(page);
  const score = (p: PageSpec) => {
    const k = loadTopics().find((t) => t.slug === p.slug)?.product_kinds ?? [];
    return (categoryOf(p)?.id === cat?.id ? 10 : 0) + k.filter((x) => kinds.has(x)).length;
  };
  return publicPages().filter((p) => p.slug !== page.slug && p.status !== 'draft').map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.p);
}

// Buscas na Amazon da página (data/search-links.json): rótulo para o leitor + link de busca com a nossa tag.
export function searchLinksFor(page: PageSpec): { label: string; url: string }[] {
  return (loadSearchLinks().pages[page.slug]?.links ?? []).map((l) => ({ label: l.label, url: amazonSearchUrl(l.query) }));
}

// Links internos no texto: primeira ocorrência das âncoras de outras páginas no ar (data/link-anchors.json),
// só da mesma categoria ("densidades de espuma" num travesseiro não leva à página de colchão D28 ou D33).
export function inlineLinks(page: PageSpec): Map<string, { start: number; end: number; href: string }> {
  const anchors = loadAnchors().pages;
  const cat = categoryOf(page)?.id;
  const targets = publicPages().filter((p) => p.status !== 'draft' && anchors[p.slug] && categoryOf(p)?.id === cat).map((p) => ({ slug: p.slug, anchors: anchors[p.slug]!.anchors }));
  return new Map([...placeLinks(page, targets)].map(([ref, l]) => [ref, { start: l.start, end: l.end, href: href(`/${l.slug}/`) }]));
}

// Tema (data/theme.json, mudado pelo chat do painel com aceite): valores validados, padrão quando ausente.
export const THEME: Theme = existsSync(join(ROOT, 'data/theme.json')) ? Theme.parse(JSON.parse(readFileSync(join(ROOT, 'data/theme.json'), 'utf8'))) : DEFAULT_THEME;
