import { join } from 'node:path';
import { z } from 'zod';
import { Claim, checkClaim, checkProduct, normalizeForMatch, Product, type Source } from '@bem-apoiado/core';
import { jevDecide, type Decider } from '../jev.ts';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { writeStage } from '../runs.ts';
import { webSearch } from '../search.ts';
import { snapshot } from '../snapshot.ts';
import { buildIndex, CLAIMS_DIR, loadProducts, PRODUCTS_DIR, sourceText, writeJson } from '../store.ts';
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
  const known = new Set(loadProducts().map((p) => p.asin));
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
      const listing = await captureListing(asin);
      if (typeof listing === 'string') {
        report.skipped.push({ url: h.url, reason: listing });
        continue;
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

const loose = (t: string) => normalizeForMatch(t).replace(/-/g, ' ');

// Captura do anúncio via Tavily; falha de UM anúncio vira motivo de pulo, nunca derruba a execução.
async function captureListing(asin: string): Promise<Source | string> {
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
    asin: a.asin, label: `${a.brand} ${a.model}`.slice(0, 80), brand: a.brand, kind: a.kind,
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
        '"depends_on_size": true se o dado muda conforme o tamanho do produto (altura, dimensões, peso, carga total); false se vale para o modelo em qualquer tamanho (densidade, material, firmeza).',
      user: `Tipos possíveis: ${kinds.join(', ')}\n\nFicha (${s.final_url}):\n"""\n${(sourceText(s.id) ?? '').slice(0, 12_000)}\n"""`,
      schema: Spec,
      schemaName: 'product_sheet',
      maxTokens: 1500,
    },
    fetchImpl,
  );
  const specClaims: Claim[] = [];
  for (const q of r.data.spec_quotes.filter((x) => !x.depends_on_size)) {
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
  opts: { maxPerKind?: number; listingsPerKind?: number } = {},
  fetchImpl?: FetchLike,
  decide: Decider = jevDecide,
): Promise<ProductsReport> {
  const topic = loadTopic(slug);
  const niche = loadNiche();
  const kinds = topic.product_kinds.length ? topic.product_kinds : niche.product_kinds.map((k) => k.id);
  const labels = new Map(niche.product_kinds.map((k) => [k.id, k.label]));
  const idx = buildIndex();
  const known = new Set(loadProducts().map((p) => p.asin));
  const makers = loadRegistry().allow.filter((a) => a.source_class === 'manufacturer');
  const report: ProductsReport = { run_id: runId, topic: slug, candidates: 0, added: [], skipped: [] };
  const Listing = z.object({ brand: z.string(), model: z.string(), is_single_product: z.boolean() });

  for (const kind of kinds) {
    let added = 0;
    const hits = (await webSearch(labels.get(kind) ?? kind, { maxResults: 10, includeDomains: ['amazon.com.br'] })).filter((h) => ASIN_RE.test(h.url));
    for (const h of hits.slice(0, opts.listingsPerKind ?? 5)) {
      if (added >= (opts.maxPerKind ?? 1)) break;
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
          system: 'Do anúncio, extraia a marca e o modelo (nome comercial curto, sem medida). "is_single_product": false se for kit, conjunto com base/box ou acessório.',
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
      const maker = makers.filter((m) => loose(m.publisher) === loose(l.data.brand));
      if (!maker.length) {
        report.skipped.push({ url: h.url, reason: `fabricante "${l.data.brand}" fora do cadastro de fontes` });
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
        ok = true;
        break;
      }
      if (!ok && sheetsFound.length === 0) report.skipped.push({ url: h.url, reason: `ficha de ${l.data.brand} ${l.data.model} não achada no site do fabricante` });
    }
  }
  writeStage(runId, 'products-amazon', { ...report, credits: creditsSpent() });
  return report;
}
