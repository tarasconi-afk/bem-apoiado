import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-pick-'));
process.env.BEM_ROOT = root;
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
mkdirSync(join(root, 'data'), { recursive: true });
copyFileSync(join(import.meta.dirname, '../../../data/niche.json'), join(root, 'data/niche.json'));

describe('produto escolhido pelo editor', () => {
  it('valida link, tipo, marca e nome; vale 45 dias sem reconferir', async () => {
    const { editorPick, editorRecheck } = await import('../src/stages/products.ts');
    const { checkProduct } = await import('@bem-apoiado/core');
    const { buildIndex } = await import('../src/store.ts');
    const now = new Date('2026-10-21T12:00:00Z');
    expect(() => editorPick({ url: 'https://www.amazon.com.br/s?k=cadeira', kind: 'cadeira', brand: 'Cavaletti', label: 'Cavaletti Air' }, now)).toThrow(/código de produto/);
    expect(() => editorPick({ url: 'https://www.amazon.com.br/dp/B0ABCDEFGH', kind: 'cadeira', brand: 'Cavaletti', label: 'Cadeira Air' }, now)).toThrow(/marca/);
    expect(() => editorPick({ url: 'https://www.amazon.com.br/dp/B0ABCDEFGH', kind: 'cadeira', brand: 'D33', label: 'D33 Air' }, now)).toThrow(/implausível/);
    const p = editorPick({ url: 'https://www.amazon.com.br/Cadeira-Air/dp/B0ABCDEFGH?ref=x', kind: 'cadeira', brand: 'Cavaletti', label: 'Cavaletti Air' }, now);
    expect(p).toMatchObject({ asin: 'B0ABCDEFGH', evidence: 'editor', editor: { checked_at: '2026-10-21' } });
    expect(checkProduct(p, buildIndex(), new Date('2026-11-30T12:00:00Z'))).toEqual([]);
    expect(checkProduct(p, buildIndex(), new Date('2026-12-20T12:00:00Z')).map((v) => v.code)).toEqual(['PRODUCT_EDITOR_STALE']);
    editorRecheck('B0ABCDEFGH', new Date('2026-12-20T12:00:00Z'));
    expect(JSON.parse(readFileSync(join(root, 'data/products/B0ABCDEFGH.json'), 'utf8')).editor.checked_at).toBe('2026-12-20');
  });
});
