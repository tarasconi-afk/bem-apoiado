import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Claim, checkClaim, checkProduct, firstForbidden, normalizeForMatch, Product, referencedClaimIds, type Source } from '@bem-apoiado/core';
import { jevDecide, type Decider } from '../jev.ts';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { writeStage } from '../runs.ts';
import { webSearch } from '../search.ts';
import { SEARCH_INDEX_NOTE, snapshot, snapshotFromSearch } from '../snapshot.ts';
const sourceNote = (s: Source) => s.note;
import { buildIndex, CLAIMS_DIR, DATA, loadPages, loadProducts, PRODUCTS_DIR, sourceText, writeJson } from '../store.ts';
import { claimIdFor, loadTopic } from './research.ts';
import { loadRegistry } from './discover.ts';

// Catálogo de afiliados a partir das fichas de fabricante já capturadas para a pauta:
// ficha (spec literal) → mesmo produto na Amazon (anúncio capturado via Tavily) → identidade conferida
// → Product com duas provas. Nunca usa imagem da Amazon (só a PA-API poderá, após 10 vendas).

const ASIN_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;

export interface ProductsReport {
  run_id: string;
  topic: string;
  candidates: number;
  added: { asin: string; label: string; kind: string }[];
  skipped: { url: string; reason: string }[];
}

export async function findProducts(slug: string, runId: string, opts: { max?: number } = {}, fetchImpl?: FetchLike, decide: Decider = jevDecide): Promise<ProductsReport> {
  const topic = loadTopic(slug);
  const niche = loadNiche();
  const kinds = topic.product_kinds.length ? topic.product_kinds : niche.product_kinds.map((k) => k.id);
  const idx = buildIndex();
  const report: ProductsReport = { run_id: runId, topic: slug, candidates: 0, added: [], skipped: [] };
  const known = knownAsins();
  const max = opts.max ?? 4;

  // 1) Fichas de UM produto entre as fontes de fabricante da pauta (triagem barata).
  const sheets: Source[] = [];
  for (const id of topic.source_ids) {
    const s = idx.sources.get(id);
    const text = sourceText(id);
    if (!s || !text || s.source_class !== 'manufacturer') continue;
    const a = await decide(`${s.final_url}\n${text.slice(0, 3000)}`, {
      ficha: {
        type: 'choice',
        instructions: 'Esta página é a ficha de UM produto específico à venda (com nome do modelo e especificações)?',
        criteria: { sim: 'ficha de um produto específico', nao: 'blog, categoria, lista de produtos, institucional, garantia' },
      },
    });
    if ((a.ficha?.probabilities?.sim ?? 0) >= 0.7) sheets.push(s);
  }
  report.candidates = sheets.length;

  const Spec = z.object({
    is_product_sheet: z.boolean(),
    brand: z.string(),
    model: z.string(),
    size: z.string(),
    kind: z.enum(kinds as [string, ...string[]]),
    spec_quotes: z.array(z.object({ quote: z.string(), statement: z.string(), depends_on_size: z.boolean() })).max(5),
  });

  for (const s of sheets) {
    if (report.added.length >= max) break;
    const text = sourceText(s.id)!;
    // 2) Especificações literais da ficha.
    const spec = await callJson(
      {
        role: 'extractor',
        system:
          'Extraia da ficha de produto: marca, modelo (nome comercial curto), tamanho/medida se houver, o tipo (do vocabulário dado) e até 4 trechos LITERAIS ' +
          'com especificações objetivas (densidade, altura, material, firmeza declarada, peso suportado). "quote" é cópia exata do texto. Sem preço. ' +
          '"depends_on_size": true se o dado muda conforme o tamanho do produto (altura, dimensões, peso, carga total); false se vale para o modelo em qualquer tamanho (densidade, material, firmeza).',
        user: `Tipos possíveis: ${kinds.join(', ')}\n\nFicha (${s.final_url}):\n"""\n${text.slice(0, 12_000)}\n"""`,
        schema: Spec,
        schemaName: 'product_sheet',
        maxTokens: 1500,
      },
      fetchImpl,
    );
    const p = spec.data;
    if (!p.is_product_sheet || !p.model.trim()) {
      report.skipped.push({ url: s.final_url, reason: 'não é ficha de produto' });
      continue;
    }
    const specClaims: Claim[] = [];
    // Só especificação que vale para o modelo em qualquer tamanho: o anúncio pode ser de outra medida.
    for (const q of p.spec_quotes.filter((x) => !x.depends_on_size)) {
      const c = Claim.safeParse({
        id: claimIdFor(s.id, q.quote), source_id: s.id, quote: q.quote.trim(), claim_type: 'spec', statement: q.statement.trim(),
        captured_at: new Date().toISOString(), question_ids: [], run_id: runId,
      });
      if (c.success && checkClaim(c.data, idx).length === 0) specClaims.push(c.data);
    }
    if (specClaims.length === 0) {
      report.skipped.push({ url: s.final_url, reason: 'nenhuma especificação literal conferida' });
      continue;
    }

    // 3) O mesmo produto na Amazon.
    // Busca por marca + modelo; a medida fica para a conferência de identidade (busca exata demais não acha).
    const query = `${p.brand} ${p.model}`.trim();
    const hits = (await webSearch(query, { maxResults: 8, includeDomains: ['amazon.com.br'] })).filter((h) => ASIN_RE.test(h.url));
    let done = false;
    for (const h of hits.slice(0, 3)) {
      const asin = ASIN_RE.exec(h.url)![1]!;
      if (known.has(asin)) {
        report.skipped.push({ url: h.url, reason: 'ASIN já no catálogo' });
        done = true;
        break;
      }
      let listing: Source | string = await captureListing(asin);
      if (typeof listing === 'string') {
        // Página bloqueada: prova pelo título e resumo do índice de busca, se trouxerem marca e tipo.
        if (h.title.split(/\s+/).length < 4) {
          report.skipped.push({ url: h.url, reason: listing });
          continue;
        }
        listing = snapshotFromSearch({ url: `https://www.amazon.com.br/dp/${asin}`, text: `${h.title.replace(/\s*[:|-]\s*Amazon\.com\.br.*$/i, '')}\n${h.content}`, publisher: 'Amazon.com.br', sourceClass: 'retailer_listing' });
      }
      const r = await confirmAndRegister({ brand: p.brand, model: p.model, kind: p.kind, specClaims, asin, listing, runId }, idx, decide);
      if (!r.ok) {
        report.skipped.push({ url: h.url, reason: r.reason });
        continue;
      }
      known.add(asin);
      report.added.push({ asin, label: r.product.label, kind: r.product.kind });
      done = true;
      break;
    }
    if (!done && hits.length === 0) report.skipped.push({ url: s.final_url, reason: `não achado na Amazon: "${query}"` });
  }
  writeStage(runId, 'products', { ...report, credits: creditsSpent() });
  return report;
}

// Já no catálogo, retirado ou recusado pelo editor: a busca não traz de volta.
function knownAsins(): Set<string> {
  const dir = join(DATA, 'products-retired');
  const retired = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  return new Set([...loadProducts().map((p) => p.asin), ...retired]);
}
const loose = (t: string) => normalizeForMatch(t).replace(/-/g, ' ');

// Palavra que identifica OUTRO tipo do vocabulário aparecendo no nome do produto (ex.: "MISTO" num
// produto classificado como espuma) → conflito: o leitor veria um nome que contradiz o tipo.
function kindConflict(name: string, kind: string): string | null {
  const kinds = loadNiche().product_kinds;
  const mine = new Set(normalizeForMatch(kinds.find((k) => k.id === kind)?.label ?? '').split(/\s+/));
  const n = loose(name);
  for (const k of kinds) {
    if (k.id === kind) continue;
    for (const w of normalizeForMatch(k.label).split(/\s+/)) {
      if (w.length >= 5 && !mine.has(w) && n.includes(w.slice(0, -1))) return w;
    }
  }
  return null;
}

// Captura do anúncio via Tavily; falha de UM anúncio vira motivo de pulo, nunca derruba a execução.
export async function captureListing(asin: string): Promise<Source | string> {
  try {
    return (await snapshot({ url: `https://www.amazon.com.br/dp/${asin}`, publisher: 'Amazon.com.br', sourceClass: 'retailer_listing', via: 'tavily' })).source;
  } catch (e) {
    return `anúncio não capturado: ${(e as Error).message.slice(0, 80)}`;
  }
}

// Confirma que ficha e anúncio são o mesmo modelo e cadastra o produto com as duas provas.
// Mesmas travas nos dois caminhos (ficha→Amazon e Amazon→ficha). Devolve o motivo quando recusa.
async function confirmAndRegister(
  a: { brand: string; model: string; kind: string; specClaims: Claim[]; asin: string; listing: Source; runId: string },
  idx: ReturnType<typeof buildIndex>,
  decide: Decider,
): Promise<{ ok: true; product: Product } | { ok: false; reason: string }> {
  const ltext = sourceText(a.listing.id) ?? '';
  const norm = loose(ltext);
  const tokens = [a.brand, ...a.model.split(/[\s-]+/)].map(loose).filter((t) => t.length >= 3);
  const missing = tokens.filter((t) => !norm.includes(t));
  if (missing.length) return { ok: false, reason: `anúncio não contém literalmente: ${missing.join(', ')}` };
  const densities = [...new Set(a.specClaims.flatMap((c) => c.quote.match(/\bD\s?\d{2}\b/gi) ?? []).map((d) => d.replace(/\s/, '').toUpperCase()))];
  if (densities.some((d) => !new RegExp(`\\b${d}\\b`, 'i').test(ltext.replace(/D\s(\d{2})/gi, 'D$1')))) {
    return { ok: false, reason: `densidade da ficha (${densities.join('/')}) não está no anúncio` };
  }
  const conflict = kindConflict(`${a.brand} ${a.model}`, a.kind);
  if (conflict) return { ok: false, reason: `nome indica outro tipo ("${conflict}")` };
  const same = await decide(`FICHA: ${a.brand} ${a.model}\n${a.specClaims.map((c) => c.quote).join(' | ')}\n\nANÚNCIO:\n${ltext.slice(0, 4000)}`, {
    mesmo: {
      type: 'choice',
      instructions: 'O anúncio é do MESMO MODELO da ficha (mesma marca e mesma linha/modelo)? A medida (solteiro, casal, queen) pode ser diferente.',
      criteria: { sim: 'mesmo modelo, em qualquer medida', nao: 'outro modelo ou linha, kit, conjunto com base, ou acessório' },
    },
  });
  if ((same.mesmo?.probabilities?.sim ?? 0) < 0.8) return { ok: false, reason: 'triagem não confirmou que é o mesmo produto' };
  const line = ltext.split('\n').find((l) => loose(l).includes(loose(a.model)) && l.length >= 15 && l.length <= 400);
  if (!line) return { ok: false, reason: 'título do anúncio não localizado' };
  const avail = Claim.parse({
    id: claimIdFor(a.listing.id, line), source_id: a.listing.id, quote: line.trim(), claim_type: 'availability',
    statement: `Anúncio de ${a.brand} ${a.model} na Amazon.com.br na data da captura.`, captured_at: new Date().toISOString(), question_ids: [], run_id: a.runId,
  });
  for (const c of [...a.specClaims, avail]) idx.claims.set(c.id, c);
  idx.sources.set(a.listing.id, a.listing);
  const product = Product.parse({
    asin: a.asin, label: `${a.brand} ${a.model}`.slice(0, 80), brand: a.brand, kind: a.kind, evidence: 'manufacturer',
    spec_claim_ids: a.specClaims.map((c) => c.id), availability_claim_id: avail.id, added_at: new Date().toISOString().slice(0, 10),
  });
  const problems = checkProduct(product, idx);
  if (problems.length) return { ok: false, reason: problems.map((x) => x.code).join(',') };
  for (const c of [...a.specClaims, avail]) writeJson(join(CLAIMS_DIR, `${c.id}.json`), c);
  writeJson(join(PRODUCTS_DIR, `${a.asin}.json`), product);
  return { ok: true, product };
}

// Especificações literais que valem para o modelo em qualquer tamanho, tiradas de uma ficha de fabricante.
async function sheetSpecs(s: Source, kinds: string[], runId: string, idx: ReturnType<typeof buildIndex>, fetchImpl?: FetchLike) {
  const Spec = z.object({
    is_product_sheet: z.boolean(),
    brand: z.string(),
    model: z.string(),
    kind: z.enum(kinds as [string, ...string[]]),
    spec_quotes: z.array(z.object({ quote: z.string(), statement: z.string(), depends_on_size: z.boolean() })).max(5),
  });
  const r = await callJson(
    {
      role: 'extractor',
      system:
        'Extraia da ficha de produto: marca, modelo (nome comercial curto), o tipo (do vocabulário dado) e até 5 trechos LITERAIS ' +
        'com especificações objetivas (densidade, altura, material, firmeza declarada, peso suportado). "quote" é cópia exata do texto. Sem preço. ' +
        '"statement" é uma frase curta e completa com o dado (ex.: "Espuma D33 aditivada"), nunca só um rótulo. ' +
        '"depends_on_size": true se o dado muda conforme o tamanho do produto (altura, dimensões, peso, carga total); false se vale para o modelo em qualquer tamanho (densidade, material, firmeza).',
      user: `Tipos possíveis: ${kinds.join(', ')}\n\nFicha (${s.final_url}):\n"""\n${(sourceText(s.id) ?? '').slice(0, 12_000)}\n"""`,
      schema: Spec,
      schemaName: 'product_sheet',
      maxTokens: 1500,
    },
    fetchImpl,
  );
  const specClaims: Claim[] = [];
  const forbidden = loadNiche().forbidden_terms;
  for (const q of r.data.spec_quotes.filter((x) => !x.depends_on_size && !firstForbidden(x.quote, forbidden))) {
    const c = Claim.safeParse({
      id: claimIdFor(s.id, q.quote), source_id: s.id, quote: q.quote.trim(), claim_type: 'spec', statement: q.statement.trim(),
      captured_at: new Date().toISOString(), question_ids: [], run_id: runId,
    });
    if (c.success && checkClaim(c.data, idx).length === 0) specClaims.push(c.data);
  }
  return { ...r.data, specClaims };
}

// CAMINHO INVERSO: anúncios da Amazon de cada tipo → marca no cadastro de fabricantes → ficha oficial
// no site daquele fabricante → mesmas travas. O catálogo da Amazon não espelha o do fabricante, então
// partir do que está à venda acerta mais.
export async function findProductsFromAmazon(
  slug: string,
  runId: string,
  opts: { maxPerKind?: number; listingsPerKind?: number; target?: number } = {},
  fetchImpl?: FetchLike,
  decide: Decider = jevDecide,
): Promise<ProductsReport> {
  const topic = loadTopic(slug);
  const niche = loadNiche();
  const kinds = topic.product_kinds.length ? topic.product_kinds : niche.product_kinds.map((k) => k.id);
  const labels = new Map(niche.product_kinds.map((k) => [k.id, k.label]));
  const idx = buildIndex();
  const known = knownAsins();
  const makers = loadRegistry().allow.filter((a) => a.source_class === 'manufacturer');
  const report: ProductsReport = { run_id: runId, topic: slug, candidates: 0, added: [], skipped: [] };
  const Listing = z.object({ brand: z.string(), model: z.string(), is_single_product: z.boolean() });
  // Quantos exemplos (pesquisa de 21/10: excesso de escolha aparece com muitas opções e comprador incerto;
  // 3 opções não confundem, opções sem diferença clara sim). Página que compara tipos: 1 por tipo, até 3.
  // Página de um tipo só: 2, de marcas diferentes. Os que a página já herda de outras contam.
  // Com item específico (pillow top), só conta o produto que a página mostra: o que tem o item no nome (23/10: os
  // colchões comuns do catálogo davam a página por "cheia" e a busca nem rodava).
  const lt = topic.listing_terms.map(loose);
  const existing = loadProducts().filter((p) => kinds.includes(p.kind) && (!lt.length || lt.some((t) => loose(p.label).includes(t))));
  const target = opts.target ?? (kinds.length > 1 ? Math.min(3, kinds.length) : 2);
  let need = Math.max(0, target - existing.length);
  const perKind = opts.maxPerKind ?? (kinds.length > 1 ? 1 : need);
  const usedBrands = new Set(existing.map((p) => loose(p.brand)));
  // Marcas que a página cita (fontes de fabricante usadas nela) vêm primeiro: texto e exemplos coerentes.
  const page = loadPages().find((p) => p.slug === slug);
  const cited = new Set<string>();
  if (page) for (const id of referencedClaimIds(page)) { const c = idx.claims.get(id); const s = c && idx.sources.get(c.source_id); if (s?.source_class === 'manufacturer') cited.add(loose(s.publisher)); }

  for (const kind of kinds) {
    if (need <= 0) break;
    let added = 0;
    // Item específico da pauta (pillow top, baú) entra na busca: exemplo à venda tem de ter o item.
    // Com item específico, busca curta: termos + palavra principal do tipo ("pillow top Colchão"). O nome inteiro do
    // tipo junto ("Colchão de espuma pillow top") não devolvia nenhum anúncio (23/10); "colchão pillow top", 8.
    const q = topic.listing_terms.length ? `${topic.listing_terms.join(' ')} ${(labels.get(kind) ?? kind).split(' ')[0]}` : (labels.get(kind) ?? kind);
    const hits = (await webSearch(q, { maxResults: 10, includeDomains: ['amazon.com.br'] }))
      .filter((h) => ASIN_RE.test(h.url))
      .sort((a, b) => Number([...cited].some((c) => loose(b.title).includes(c))) - Number([...cited].some((c) => loose(a.title).includes(c))));
    for (const h of hits.slice(0, opts.listingsPerKind ?? 10)) {
      if (added >= perKind || need <= 0) break;
      const asin = ASIN_RE.exec(h.url)![1]!;
      if (known.has(asin)) continue;
      report.candidates++;
      const listing = await captureListing(asin);
      if (typeof listing === 'string') {
        report.skipped.push({ url: h.url, reason: listing });
        continue;
      }
      const l = await callJson(
        {
          role: 'extractor',
          system: 'Do anúncio, extraia a marca e o modelo (nome comercial curto, sem medida). A marca é o fabricante (ex.: campo "Marca" do anúncio); se o anúncio não diz qual é, devolva brand vazio: nunca use densidade, medida, material ou o nome do modelo como marca. "is_single_product": false se for kit, conjunto com base/box ou acessório.',
          user: (sourceText(listing.id) ?? '').slice(0, 6000),
          schema: Listing,
          schemaName: 'listing',
          maxTokens: 300,
        },
        fetchImpl,
      );
      if (!l.data.is_single_product) {
        report.skipped.push({ url: h.url, reason: 'kit/conjunto/acessório' });
        continue;
      }
      const bad = brandProblem(l.data.brand, labels.get(kind) ?? kind);
      if (bad) {
        report.skipped.push({ url: h.url, reason: bad });
        continue;
      }
      // O anúncio vende o PRÓPRIO produto do tipo, e não capa, bolsa, protetor, base ou acessório?
      const kindLabel = labels.get(kind) ?? kind;
      const isItem = await decide((sourceText(listing.id) ?? '').slice(0, 4000), {
        item: {
          type: 'choice',
          instructions: `Este anúncio vende um(a) ${kindLabel.toLowerCase()} propriamente dito(a)?`,
          criteria: { sim: `o produto vendido é um(a) ${kindLabel.toLowerCase()} para uso normal em casa`, nao: 'capa, bolsa, protetor, base, cama, kit, peça, acessório, ou versão de viagem, portátil, para pet ou infantil' },
        },
      });
      if ((isItem.item?.probabilities?.sim ?? 0) < 0.85) {
        report.skipped.push({ url: h.url, reason: `triagem: não vende o próprio ${kindLabel.toLowerCase()}` });
        continue;
      }
      // Sem a página do anúncio (só índice de busca), a confiança vem da marca: só fabricante do cadastro.
      const fromSearch = sourceNote(listing) === SEARCH_INDEX_NOTE;
      if (fromSearch && !makers.some((m) => [m.publisher, ...(m.aliases ?? [])].some((n) => loose(n) === loose(l.data.brand)))) {
        report.skipped.push({ url: h.url, reason: `página do anúncio bloqueada e marca "${l.data.brand}" fora do cadastro de fabricantes` });
        continue;
      }
      // Marcas diferentes na mesma página: dois exemplos da mesma marca não ajudam a decidir.
      if (usedBrands.has(loose(l.data.brand))) {
        report.skipped.push({ url: h.url, reason: `marca já tem exemplo nesta página: ${l.data.brand}` });
        continue;
      }
      const maker = makers.filter((m) => [m.publisher, ...(m.aliases ?? [])].some((n) => loose(n) === loose(l.data.brand)));
      if (!maker.length) {
        const r = await registerListingOnly({ brand: l.data.brand, model: l.data.model, kind, asin, listing, runId }, idx, labels.get(kind) ?? kind);
        if (r.ok) {
          known.add(asin);
          report.added.push({ asin, label: `${r.product.label} [só anúncio]`, kind });
          added++;
          need--;
          usedBrands.add(loose(l.data.brand));
        } else report.skipped.push({ url: h.url, reason: `fabricante "${l.data.brand}" fora do cadastro; nível anúncio: ${r.reason}` });
        continue;
      }
      // Ficha oficial no site do fabricante.
      const sheetsFound = (await webSearch(`${l.data.brand} ${l.data.model}`, { maxResults: 5, includeDomains: maker.map((m) => m.host) })).slice(0, 2);
      let ok = false;
      for (const sh of sheetsFound) {
        let sheet: Source;
        try {
          sheet = (await snapshot({ url: sh.url, publisher: maker[0]!.publisher, sourceClass: 'manufacturer' })).source;
        } catch (e) {
          report.skipped.push({ url: sh.url, reason: `ficha não capturada: ${(e as Error).message.slice(0, 60)}` });
          continue;
        }
        idx.sources.set(sheet.id, sheet);
        const spec = await sheetSpecs(sheet, kinds, runId, idx, fetchImpl);
        if (!spec.is_product_sheet || spec.specClaims.length === 0) {
          report.skipped.push({ url: sh.url, reason: 'não é ficha de produto ou sem especificação literal' });
          continue;
        }
        const r = await confirmAndRegister({ brand: l.data.brand, model: l.data.model, kind: spec.kind, specClaims: spec.specClaims, asin, listing, runId }, idx, decide);
        if (!r.ok) {
          report.skipped.push({ url: h.url, reason: r.reason });
          continue;
        }
        known.add(asin);
        report.added.push({ asin, label: r.product.label, kind: r.product.kind });
        added++;
        need--;
        usedBrands.add(loose(l.data.brand));
        ok = true;
        break;
      }
      if (!ok) {
        // Sem ficha oficial conferida: tenta o nível "só anúncio" (sem especificação, tipo atribuído ao vendedor).
        const r = await registerListingOnly({ brand: l.data.brand, model: l.data.model, kind, asin, listing, runId }, idx, labels.get(kind) ?? kind);
        if (r.ok) {
          known.add(asin);
          report.added.push({ asin, label: `${r.product.label} [só anúncio]`, kind });
          added++;
          need--;
          usedBrands.add(loose(l.data.brand));
        } else report.skipped.push({ url: h.url, reason: `sem ficha oficial; nível anúncio: ${r.reason}` });
      }
    }
  }
  writeStage(runId, 'products-amazon', { ...report, credits: creditsSpent() });
  return report;
}

// Marca plausível: não vazia, sem artigo no início, no máximo 3 palavras ("O armazenamento do colchão"
// não é marca), não só palavra genérica do produto ("Espuma D33-20cm" não tem marca) e sem especificação
// no lugar ("D33 Miami" virou marca "D33"; 21/10). Vale na entrada e na renovação (refresh retira).
export function brandProblem(brand: string, kindLabel: string): string | null {
  const b = brand.trim();
  const generic = new Set([...loose(kindLabel).split(/\s+/), 'colchao', 'colchão', 'espuma', 'travesseiro', 'mola', 'molas', 'cadeira', 'mesa', 'suporte', 'almofada', 'generico', 'genérico', 'generica', 'genérica', 'sem', 'marca', 'kit']);
  if (!b || loose(b).split(/\s+/).every((w) => generic.has(w))) return `marca genérica: "${brand}"`;
  if (/^(o|a|os|as|um|uma)\s/i.test(b) || b.split(/\s+/).length > 3 || b.split(/\s+/).some((w) => /\d/.test(w))) return `marca implausível: "${brand}"`;
  return null;
}

// Nível "só anúncio": sem ficha oficial. O cartão mostra apenas o tipo "anunciado como", com a linha
// literal do anúncio que contém as palavras do tipo. Nenhuma especificação.
async function registerListingOnly(
  a: { brand: string; model: string; kind: string; asin: string; listing: Source; runId: string },
  idx: ReturnType<typeof buildIndex>,
  kindLabel: string,
): Promise<{ ok: true; product: Product } | { ok: false; reason: string }> {
  const ltext = sourceText(a.listing.id) ?? '';
  const words = normalizeForMatch(kindLabel).split(/\s+/).filter((w) => w.length >= 5).map((w) => w.slice(0, -1));
  const forbidden = loadNiche().forbidden_terms;
  const nameWords = [a.brand, ...a.model.split(/[\s-]+/)].map(loose).filter((w) => w.length >= 3);
  // Trecho = PREFIXO literal de uma linha de texto (nunca imagem/link), cortado antes do primeiro termo
  // proibido, que contenha marca, modelo e as palavras do tipo.
  let line: string | undefined;
  for (const raw of ltext.split('\n')) {
    // Espaços colapsados: o índice do termo proibido (calculado no texto normalizado) bate com esta linha.
    const l = raw.replace(/^[#>*\s]+/, '').replace(/\s+/g, ' ').trim();
    if (l.length < 15 || l.length > 400 || /!\[|\]\(|https?:\/\//.test(l)) continue;
    // Índice no texto normalizado; NFC preserva o comprimento em português, então o corte bate no original.
    const cutAt = firstForbidden(l, forbidden)?.index;
    let cand = l;
    if (cutAt !== undefined) {
      const head = l.slice(0, cutAt);
      const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(' - '), head.lastIndexOf(';'));
      cand = (cut > 0 ? head.slice(0, cut) : head).replace(/[\s,;:\-–—(]+$/, '').trim();
    }
    const c = loose(cand);
    if (cand.length >= 15 && nameWords.every((w) => c.includes(w)) && words.every((w) => c.includes(w))) {
      line = cand;
      break;
    }
  }
  if (!line) return { ok: false, reason: `nenhum trecho do anúncio traz marca + modelo + "${kindLabel}" sem termo proibido` };
  const conflict = kindConflict(`${a.brand} ${a.model}`, a.kind);
  if (conflict) return { ok: false, reason: `nome indica outro tipo ("${conflict}")` };

  const avail = Claim.parse({
    id: claimIdFor(a.listing.id, line), source_id: a.listing.id, quote: line.trim(), claim_type: 'availability',
    statement: `Anúncio de ${a.brand} ${a.model} na Amazon.com.br, que o descreve como ${kindLabel.toLowerCase()}.`,
    captured_at: new Date().toISOString(), question_ids: [], run_id: a.runId,
  });
  idx.claims.set(avail.id, avail);
  idx.sources.set(a.listing.id, a.listing);
  const product = Product.parse({
    asin: a.asin, label: `${a.brand} ${a.model}`.slice(0, 80), brand: a.brand, kind: a.kind, evidence: 'listing',
    spec_claim_ids: [], availability_claim_id: avail.id, added_at: new Date().toISOString().slice(0, 10),
  });
  const problems = checkProduct(product, idx, new Date(), kindLabel, loadNiche().forbidden_terms);
  if (problems.length) return { ok: false, reason: problems.map((x) => x.code).join(',') };
  writeJson(join(CLAIMS_DIR, `${avail.id}.json`), avail);
  writeJson(join(PRODUCTS_DIR, `${a.asin}.json`), product);
  return { ok: true, product };
}

// Produto escolhido pelo editor no painel (link colado): sem leitura do anúncio. Validações de sempre: ASIN,
// tipo do nicho, marca plausível, nome sem promoção. Reconferir renova a data; remover vai para retirados.
export function editorPick(input: { url: string; kind: string; brand: string; label: string }, now = new Date()): Product {
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(input.url)?.[1] ?? (/^[A-Z0-9]{10}$/.test(input.url.trim()) ? input.url.trim() : null);
  if (!asin) throw new Error('link sem código de produto da Amazon (/dp/XXXXXXXXXX)');
  const niche = loadNiche();
  const kind = niche.product_kinds.find((k) => k.id === input.kind);
  if (!kind) throw new Error(`tipo desconhecido: ${input.kind}`);
  const bad = brandProblem(input.brand, kind.label);
  if (bad) throw new Error(bad);
  const label = input.label.replace(/\s+/g, ' ').trim();
  if (!loose(label).includes(loose(input.brand.trim()))) throw new Error('o nome do produto precisa trazer a marca');
  const day = now.toISOString().slice(0, 10);
  const p = Product.parse({ asin, label, brand: input.brand.trim(), kind: kind.id, evidence: 'editor', spec_claim_ids: [], editor: { checked_at: day }, added_at: day });
  const problems = checkProduct(p, buildIndex(), now, kind.label, niche.forbidden_terms);
  if (problems.length) throw new Error(problems.map((x) => `${x.code}: ${x.detail}`).join('; '));
  writeJson(join(PRODUCTS_DIR, `${asin}.json`), p);
  return p;
}

export function editorRecheck(asin: string, now = new Date()): Product {
  const p = loadProducts().find((x) => x.asin === asin);
  if (!p || p.evidence !== 'editor') throw new Error(`${asin} não é escolha do editor`);
  const up = Product.parse({ ...p, editor: { checked_at: now.toISOString().slice(0, 10) } });
  writeJson(join(PRODUCTS_DIR, `${asin}.json`), up);
  return up;
}

// Aviso ao editor ao cadastrar (22/10: um anúncio da Namoat usava "Cadeira Flexform" no título como isca de
// busca). Só o endereço é lido, a Amazon bloqueia a página: título que cita outra marca conhecida, ou que não
// cita a marca informada, pede conferir o campo "Marca" do anúncio. Não impede o cadastro.
export function listingWarnings(url: string, brand: string, knownBrands: string[]): string[] {
  let slug = '';
  try {
    slug = decodeURIComponent(new URL(url).pathname.split('/dp/')[0] ?? '').replace(/[-/]+/g, ' ').toLowerCase();
  } catch {
    return [];
  }
  if (!slug.trim()) return [];
  const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const s = norm(slug);
  const out: string[] = [];
  const others = [...new Set(knownBrands)].filter((b) => norm(b) !== norm(brand) && b.length >= 3 && new RegExp(`\\b${norm(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s));
  if (others.length) out.push(`o título do anúncio cita ${others.join(', ')}: confira o campo "Marca" no anúncio (revendedor às vezes usa nome de marca como palavra-chave)`);
  if (!s.includes(norm(brand))) out.push(`o título do anúncio não cita ${brand}: confira o campo "Marca" no anúncio`);
  return out;
}
