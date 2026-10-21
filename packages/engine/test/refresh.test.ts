import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Source } from '@bem-apoiado/core';

const root = mkdtempSync(join(tmpdir(), 'bem-refresh-'));
process.env.BEM_ROOT = root;
process.env.BEM_STATE_DIR = join(root, 'state');
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
mkdirSync(join(root, 'data'), { recursive: true });
copyFileSync(join(import.meta.dirname, '../../../data/niche.json'), join(root, 'data/niche.json'));

const { refreshProducts } = await import('../src/stages/refresh.ts');
const { pagesNeedingProducts } = await import('../src/stages/autopilot.ts');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const QUOTE = 'Colchão Casal Emma Original 25 cm - 138x188 cm, Espuma Viscoelástica 3 Camadas';
const LISTING = (extra = '') => `#### Imagem não disponível\n${QUOTE}\nAções disponíveis\n${extra}\n` + 'texto do anúncio '.repeat(20);

let seq = 0;
function source(asin: string, text: string): Source {
  const id = `src_${(++seq).toString(16).padStart(12, '0')}`;
  const url = `https://www.amazon.com.br/dp/${asin}`;
  const s = {
    id, url, final_url: url, fetched_at: NOW.toISOString(), http_status: 200, content_type: 'text/plain', sha256: 'a'.repeat(64),
    raw_file: 'raw.txt', text_file: 'text.txt', text_chars: text.length, extractor_version: 2, title: null, publisher: 'Amazon.com.br',
    source_class: 'retailer_listing',
  } as Source;
  mkdirSync(join(root, 'data/sources', id), { recursive: true });
  writeFileSync(join(root, 'data/sources', id, 'meta.json'), JSON.stringify(s));
  writeFileSync(join(root, 'data/sources', id, 'text.txt'), text);
  writeFileSync(join(root, 'data/sources', id, 'raw.txt'), text);
  return s;
}

function product(asin: string, capturedDaysAgo: number) {
  const s = source(asin, LISTING());
  const claimId = `clm_${asin.toLowerCase().slice(0, 10).padEnd(12, '0')}`;
  mkdirSync(join(root, 'data/claims'), { recursive: true });
  mkdirSync(join(root, 'data/products'), { recursive: true });
  writeFileSync(join(root, 'data/claims', `${claimId}.json`), JSON.stringify({
    id: claimId, source_id: s.id, quote: QUOTE, claim_type: 'availability', statement: 'Anúncio de Emma Original na Amazon.com.br.',
    captured_at: new Date(NOW.getTime() - capturedDaysAgo * 86_400_000).toISOString(), question_ids: [],
  }));
  writeFileSync(join(root, 'data/products', `${asin}.json`), JSON.stringify({
    asin, label: 'Emma Original', brand: 'Emma', kind: 'espuma', evidence: 'listing', spec_claim_ids: [], availability_claim_id: claimId, added_at: '2026-10-20',
  }));
}

const productFile = (asin: string) => join(root, 'data/products', `${asin}.json`);
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('renovação da disponibilidade', () => {
  it('renova quando o trecho continua; retira quando mudou, quando não há oferta, ou quando a prova venceu sem recaptura', async () => {
    product('B000000001', 2); // recente: nem tenta
    product('B000000002', 10); // trecho continua → renova
    product('B000000003', 10); // trecho mudou → retira
    product('B000000004', 10); // sem oferta → retira
    product('B000000005', 10); // captura falha, prova ainda válida → mantém
    product('B000000006', 31); // captura falha, prova vencida → retira
    const calls: string[] = [];
    const capture = async (asin: string) => {
      calls.push(asin);
      if (asin === 'B000000002') return source(asin, LISTING());
      if (asin === 'B000000003') return source(asin, 'Colchão Emma Original outra descrição\n' + 'x '.repeat(200));
      if (asin === 'B000000004') return source(asin, LISTING('Nenhuma oferta em destaque disponível'));
      return 'anúncio não capturado: vazio';
    };
    const r = await refreshProducts('run_teste', { now: NOW }, capture);
    expect(calls).not.toContain('B000000001');
    expect(r.refreshed.map((x) => x.asin)).toEqual(['B000000002']);
    expect(r.retired.map((x) => x.asin).sort()).toEqual(['B000000003', 'B000000004', 'B000000006']);
    expect(r.kept.map((x) => x.asin)).toEqual(['B000000005']);

    const p2 = read(productFile('B000000002'));
    const c2 = read(join(root, 'data/claims', `${p2.availability_claim_id}.json`));
    expect(c2.captured_at).toBe(NOW.toISOString());
    expect(c2.quote).toBe(QUOTE);
    for (const a of ['B000000003', 'B000000004', 'B000000006']) {
      expect(existsSync(productFile(a))).toBe(false);
      expect(read(join(root, 'data/products-retired', `${a}.json`)).reason).toBeTruthy();
    }
    expect(existsSync(productFile('B000000005'))).toBe(true);

    // Mesma semana: o que falhou não é recapturado de novo (o ramo ainda não foi aceito).
    calls.length = 0;
    await refreshProducts('run_teste2', { now: new Date(NOW.getTime() + 86_400_000) }, capture);
    expect(calls).not.toContain('B000000005');
  });
});

describe('renovação com a página do anúncio bloqueada', () => {
  it('leitura falha mas o anúncio está no índice de busca: renova pelo índice em vez de retirar', async () => {
    product('B000000007', 31); // prova vencida, leitura bloqueada
    product('B000000008', 31); // prova vencida, nem leitura nem índice
    const capture = async () => 'anúncio não capturado: extração vazia';
    const fromIndex = async (p: { asin: string }) => (p.asin === 'B000000007' ? source(p.asin, `${QUOTE}\nresumo do anúncio no índice de busca`) : null);
    const r = await refreshProducts('run_bloqueio', { now: NOW }, capture, fromIndex as never);
    expect(r.refreshed.map((x) => x.asin)).toContain('B000000007');
    expect(r.retired.map((x) => x.asin)).toContain('B000000008');
    expect(existsSync(productFile('B000000007'))).toBe(true);
  });
});

describe('produtos para páginas no ar', () => {
  const page = (slug: string, status: 'draft' | 'approved') => ({ slug, status }) as never;
  const topic = (slug: string, kinds: string[]) => ({ slug, product_kinds: kinds }) as never;
  const prod = (kind: string) => ({ kind }) as never;

  it('só página aprovada com menos de 3 exemplos dos seus tipos, uma tentativa por semana', () => {
    const pages = [page('a', 'approved'), page('b', 'draft'), page('c', 'approved'), page('d', 'approved')];
    const topics = [topic('a', ['espuma']), topic('b', ['espuma']), topic('c', ['travesseiro']), topic('d', [])];
    expect(pagesNeedingProducts(pages, topics, [prod('travesseiro')], {}, NOW)).toEqual(['a', 'c']);
    const three = [prod('travesseiro'), prod('travesseiro'), prod('travesseiro')];
    expect(pagesNeedingProducts(pages, topics, three, {}, NOW)).toEqual(['a']);
    const recent = { a: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() };
    expect(pagesNeedingProducts(pages, topics, three, recent, NOW)).toEqual([]);
    const old = { a: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() };
    expect(pagesNeedingProducts(pages, topics, three, old, NOW)).toEqual(['a']);
  });
});
