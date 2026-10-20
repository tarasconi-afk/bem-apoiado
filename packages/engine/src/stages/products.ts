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
      const listing = await snapshot({ url: `https://www.amazon.com.br/dp/${asin}`, publisher: 'Amazon.com.br', sourceClass: 'retailer_listing', via: 'tavily' });
      const ltext = sourceText(listing.source.id) ?? '';
      // 4) Identidade: marca e cada palavra do modelo têm de aparecer literalmente no anúncio, e o Jev confirma.
      // Hífen e espaço contam como iguais ("Guarda-Costas" = "Guarda Costas").
      const loose = (t: string) => normalizeForMatch(t).replace(/-/g, ' ');
      const norm = loose(ltext);
      const tokens = [p.brand, ...p.model.split(/[\s-]+/)].map(loose).filter((t) => t.length >= 3);
      if (!tokens.every((t) => norm.includes(t))) {
        report.skipped.push({ url: h.url, reason: `anúncio não contém literalmente: ${tokens.filter((t) => !norm.includes(t)).join(', ')}` });
        continue;
      }
      // Densidade declarada (ex.: D28) tem de bater literalmente com o anúncio.
      const densities = [...new Set(specClaims.flatMap((c) => c.quote.match(/\bD\s?\d{2}\b/gi) ?? []).map((d) => d.replace(/\s/, '').toUpperCase()))];
      if (densities.some((d) => !new RegExp(`\\b${d}\\b`, 'i').test(ltext.replace(/D\s(\d{2})/gi, 'D$1')))) {
        report.skipped.push({ url: h.url, reason: `densidade da ficha (${densities.join('/')}) não está no anúncio` });
        continue;
      }
      const same = await decide(`FICHA: ${p.brand} ${p.model}\n${specClaims.map((c) => c.quote).join(' | ')}\n\nANÚNCIO:\n${ltext.slice(0, 4000)}`, {
        mesmo: {
          type: 'choice',
          instructions: 'O anúncio é do MESMO MODELO da ficha (mesma marca e mesma linha/modelo)? A medida (solteiro, casal, queen) pode ser diferente.',
          criteria: { sim: 'mesmo modelo, em qualquer medida', nao: 'outro modelo ou linha, kit, conjunto com base, ou acessório' },
        },
      });
      if ((same.mesmo?.probabilities?.sim ?? 0) < 0.8) {
        report.skipped.push({ url: h.url, reason: 'triagem não confirmou que é o mesmo produto' });
        continue;
      }
      // 5) Prova de disponibilidade: a linha do anúncio com o modelo, literal.
      const line = ltext.split('\n').find((l) => loose(l).includes(loose(p.model)) && l.length >= 15 && l.length <= 400);
      if (!line) {
        report.skipped.push({ url: h.url, reason: 'título do anúncio não localizado' });
        continue;
      }
      const avail = Claim.parse({
        id: claimIdFor(listing.source.id, line), source_id: listing.source.id, quote: line.trim(), claim_type: 'availability',
        statement: `Anúncio de ${p.brand} ${p.model} na Amazon.com.br na data da captura.`, captured_at: new Date().toISOString(), question_ids: [], run_id: runId,
      });
      for (const c of [...specClaims, avail]) {
        writeJson(join(CLAIMS_DIR, `${c.id}.json`), c);
        idx.claims.set(c.id, c);
      }
      idx.sources.set(listing.source.id, listing.source);
      const product = Product.parse({
        asin, label: `${p.brand} ${p.model}`.slice(0, 80), brand: p.brand, kind: p.kind,
        spec_claim_ids: specClaims.map((c) => c.id), availability_claim_id: avail.id, added_at: new Date().toISOString().slice(0, 10),
      });
      const problems = checkProduct(product, idx);
      if (problems.length) {
        report.skipped.push({ url: h.url, reason: problems.map((x) => x.code).join(',') });
        continue;
      }
      writeJson(join(PRODUCTS_DIR, `${asin}.json`), product);
      known.add(asin);
      report.added.push({ asin, label: product.label, kind: product.kind });
      done = true;
      break;
    }
    if (!done && hits.length === 0) report.skipped.push({ url: s.final_url, reason: `não achado na Amazon: "${query}"` });
  }
  writeStage(runId, 'products', { ...report, credits: creditsSpent() });
  return report;
}
