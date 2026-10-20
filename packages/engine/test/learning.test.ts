import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-learning-'));
process.env.BEM_ROOT = root;

const src = (id: string, url: string) => ({
  id, url, final_url: url, fetched_at: '2026-10-20T12:00:00.000Z', http_status: 200, content_type: 'text/html',
  sha256: 'c'.repeat(64), raw_file: 'raw.html', text_file: 'text.txt', text_chars: 10, extractor_version: 2,
  title: 't', publisher: 'Pub', source_class: 'manufacturer',
});

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  for (const [id, url] of [['src_aaaaaaaaaaa1', 'https://boa.test/ficha'], ['src_aaaaaaaaaaa2', 'https://ruim.test/garantia'], ['src_aaaaaaaaaaa3', 'https://ruim.test/sobre']]) {
    mkdirSync(join(root, 'data/sources', id!), { recursive: true });
    writeFileSync(join(root, 'data/sources', id!, 'meta.json'), JSON.stringify(src(id!, url!)));
    writeFileSync(join(root, 'data/sources', id!, 'text.txt'), 'x');
  }
  mkdirSync(join(root, 'data/claims'), { recursive: true });
  writeFileSync(join(root, 'data/claims/clm_boa_1.json'), JSON.stringify({
    id: 'clm_boa_1', source_id: 'src_aaaaaaaaaaa1', quote: 'trecho literal útil aqui', claim_type: 'spec', statement: 'útil e fiel',
    captured_at: '2026-10-20T12:00:00.000Z', question_ids: ['q_x'],
  }));
  mkdirSync(join(root, 'data/topics'), { recursive: true });
  writeFileSync(join(root, 'data/topics/t.json'), JSON.stringify({
    slug: 't', primary_query: 'tema de teste', page_type: 'explainer', questions: [{ id: 'q_x', text: 'pergunta de teste longa' }],
    source_ids: ['src_aaaaaaaaaaa1', 'src_aaaaaaaaaaa2', 'src_aaaaaaaaaaa3'],
    researched_source_ids: ['src_aaaaaaaaaaa1', 'src_aaaaaaaaaaa2', 'src_aaaaaaaaaaa3'],
    evidence_gaps: ['tabela de medidas por idade'],
  }));
});

describe('aprendizado acumulado', () => {
  it('mede rendimento por domínio e marca páginas inúteis', async () => {
    const { computeLearning, plannerHints } = await import('../src/learning.ts');
    const l = computeLearning();
    expect(l.domains.get('boa.test')!.yield).toBeGreaterThan(l.domains.get('ruim.test')!.yield);
    expect(l.unproductiveUrls.has('https://ruim.test/garantia')).toBe(true);
    const h = plannerHints(l);
    expect(h).toContain('boa.test');
    expect(h).toContain('ruim.test');
    expect(h).toContain('tabela de medidas por idade');
  });
});
