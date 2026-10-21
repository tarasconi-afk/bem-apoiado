import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AVAILABILITY_MAX_AGE_DAYS, Claim, checkProduct, normalizeForMatch, quoteAppearsIn, type Product, type Source } from '@bem-apoiado/core';
import { loadNiche } from '../niche.ts';
import { writeStage } from '../runs.ts';
import { creditsThisMonth, MONTHLY_CREDIT_CAP, webSearch } from '../search.ts';
import { snapshotFromSearch } from '../snapshot.ts';
import { loadRegistry } from './discover.ts';
import { buildIndex, CLAIMS_DIR, DATA, loadProducts, PRODUCTS_DIR, readState, sourceText, writeJson, writeState } from '../store.ts';
import { claimIdFor } from './research.ts';
import { brandProblem, captureListing } from './products.ts';

// Renovação da disponibilidade: cada produto tem o anúncio recapturado antes de a prova envelhecer
// (o gate recusa disponibilidade com mais de 30 dias). Só renova se o MESMO trecho literal continua
// no anúncio; se sumiu, se o anúncio diz que não há oferta, ou se a prova venceu sem recaptura, o produto
// sai do catálogo (vai para products-retired/ com o motivo). Cartão velho ou falso nunca chega ao site.

export const RETIRED_DIR = join(DATA, 'products-retired');
export const REFRESH_AFTER_DAYS = 7;

// Sinais de anúncio sem compra possível. "Imagem não disponível" e "Ações disponíveis" aparecem em
// qualquer anúncio e não contam.
const UNAVAILABLE = [/nenhuma oferta em destaque dispon[ií]vel/i, /atualmente indispon[ií]vel/i, /^\W*n[ãa]o dispon[ií]vel\.?\s*$/im];

export interface RefreshReport {
  run_id: string;
  refreshed: { asin: string; claim_id: string }[];
  retired: { asin: string; reason: string }[];
  kept: { asin: string; reason: string }[];
}

type Capture = (asin: string) => Promise<Source | string>;

const ageDays = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 86_400_000;

function retire(p: Product, reason: string, now: Date): void {
  writeJson(join(RETIRED_DIR, `${p.asin}.json`), { ...p, retired_at: now.toISOString(), reason });
  const f = join(PRODUCTS_DIR, `${p.asin}.json`);
  if (existsSync(f)) unlinkSync(f);
}

// Página do anúncio bloqueada (a Amazon devolve vazio à leitura automática desde 21/10): a prova vem do
// título e do resumo do próprio anúncio no índice de busca, só para marca do cadastro de fabricantes. O
// cartão passa a dizer "anúncio encontrado em". Sem isto, os cartões dos colchões sairiam do ar em 30 dias.
export type IndexLookup = (p: Product) => Promise<Source | null>;
export const lookupInSearchIndex: IndexLookup = async (p) => {
  const makers = loadRegistry().allow.filter((a) => a.source_class === 'manufacturer');
  const norm = (t: string) => normalizeForMatch(t);
  if (!makers.some((m) => [m.publisher, ...(m.aliases ?? [])].some((n) => norm(n) === norm(p.brand)))) return null;
  // Nome curto, título do anúncio (o trecho da prova anterior) e o código: o primeiro que trouxer o anúncio.
  const quote = buildIndex().claims.get(p.availability_claim_id ?? '')?.quote ?? '';
  const queries = [p.label, quote.split(/\s+/).slice(0, 8).join(' '), p.asin].filter((q, i, a) => q && a.indexOf(q) === i);
  let h: Awaited<ReturnType<typeof webSearch>>[number] | undefined;
  for (const q of queries) {
    h = (await webSearch(q, { maxResults: 8, includeDomains: ['amazon.com.br'] })).find((x) => x.url.includes(`/dp/${p.asin}`) || x.url.includes(`/gp/product/${p.asin}`));
    if (h) break;
  }
  if (!h) return null;
  return snapshotFromSearch({ url: `https://www.amazon.com.br/dp/${p.asin}`, text: `${h.title.replace(/\s*[:|-]\s*Amazon\.com\.br.*$/i, '')}\n${h.content}`, publisher: 'Amazon.com.br', sourceClass: 'retailer_listing' });
};

export async function refreshProducts(
  runId: string,
  opts: { maxAgeDays?: number; now?: Date } = {},
  capture: Capture = captureListing,
  fromIndex: IndexLookup = lookupInSearchIndex,
): Promise<RefreshReport> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeDays ?? REFRESH_AFTER_DAYS;
  const niche = loadNiche();
  const labels = new Map(niche.product_kinds.map((k) => [k.id, k.label]));
  const idx = buildIndex();
  const report: RefreshReport = { run_id: runId, refreshed: [], retired: [], kept: [] };

  // Última tentativa por ASIN (fora do git): enquanto o ramo com a renovação não é aceito, o main
  // continua com a prova antiga; sem isto o ciclo recapturaria (e pagaria) todo dia.
  const tried = readState<Record<string, string>>('products-refresh.json', {});
  for (const p of loadProducts()) {
    // Escolha do editor não é relida: ele mesmo reconfere pelo painel.
    if (p.evidence === 'editor') continue;
    const badBrand = brandProblem(p.brand, labels.get(p.kind) ?? p.kind);
    if (badBrand) {
      retire(p, badBrand, now);
      report.retired.push({ asin: p.asin, reason: badBrand });
      continue;
    }
    const old = idx.claims.get(p.availability_claim_id ?? '');
    const age = old ? ageDays(old.captured_at, now) : Infinity;
    if (age < maxAge) continue;
    const expiredNow = age > AVAILABILITY_MAX_AGE_DAYS;
    if (!expiredNow && tried[p.asin] && ageDays(tried[p.asin]!, now) < maxAge) continue;
    tried[p.asin] = now.toISOString();
    const expired = age > AVAILABILITY_MAX_AGE_DAYS;
    if (!old) {
      retire(p, 'prova de disponibilidade inexistente', now);
      report.retired.push({ asin: p.asin, reason: 'prova de disponibilidade inexistente' });
      continue;
    }
    if (creditsThisMonth() >= MONTHLY_CREDIT_CAP) {
      // Sem cota de busca: só tira do ar o que já venceu; o resto espera o próximo mês.
      if (expired) {
        retire(p, 'prova vencida e cota mensal do Tavily esgotada', now);
        report.retired.push({ asin: p.asin, reason: 'prova vencida; cota do Tavily esgotada' });
      } else report.kept.push({ asin: p.asin, reason: 'cota do Tavily esgotada' });
      continue;
    }
    let fresh: Source | string = await capture(p.asin);
    if (typeof fresh === 'string') fresh = (await fromIndex(p).catch(() => null)) ?? fresh;
    if (typeof fresh === 'string') {
      // Falha de captura pode ser passageira: só retira se a prova já venceu.
      if (expired) {
        retire(p, `prova vencida e ${fresh}`, now);
        report.retired.push({ asin: p.asin, reason: fresh });
      } else report.kept.push({ asin: p.asin, reason: fresh });
      continue;
    }
    const text = sourceText(fresh.id) ?? '';
    const reason = UNAVAILABLE.some((re) => re.test(text))
      ? 'anúncio sem oferta disponível'
      : !quoteAppearsIn(old.quote, text)
        ? 'trecho do anúncio mudou'
        : null;
    if (reason) {
      retire(p, reason, now);
      report.retired.push({ asin: p.asin, reason });
      continue;
    }
    // Mesmo conteúdo do arquivo anterior: o snapshot é reaproveitado e a prova ganha só a data nova.
    const claim = Claim.parse({ ...old, id: claimIdFor(fresh.id, old.quote), source_id: fresh.id, captured_at: now.toISOString(), run_id: runId });
    idx.claims.set(claim.id, claim);
    idx.sources.set(fresh.id, fresh);
    const updated: Product = { ...p, availability_claim_id: claim.id };
    const problems = checkProduct(updated, idx, now, labels.get(p.kind), niche.forbidden_terms);
    if (problems.length) {
      const why = problems.map((x) => x.code).join(',');
      retire(p, why, now);
      report.retired.push({ asin: p.asin, reason: why });
      continue;
    }
    writeJson(join(CLAIMS_DIR, `${claim.id}.json`), claim);
    writeJson(join(PRODUCTS_DIR, `${p.asin}.json`), updated);
    report.refreshed.push({ asin: p.asin, claim_id: claim.id });
  }
  writeState('products-refresh.json', tried);
  writeStage(runId, 'refresh-products', report);
  return report;
}
