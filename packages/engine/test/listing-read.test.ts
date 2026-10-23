import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-read-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
mkdirSync(join(root, 'data'), { recursive: true });
copyFileSync(join(import.meta.dirname, '../../../data/niche.json'), join(root, 'data/niche.json'));

const llm = (out: unknown) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))) as never;

describe('ler anúncio pelo link', () => {
  it('preenche marca, nome e tipo; anúncio bloqueado cai no índice de busca; sem nada, erro claro', async () => {
    const { readListingInfo } = await import('../src/stages/products.ts');
    const page = 'Pillow Top Super Volumosa 1.000 gramas/m² de Fibra Siliconizada - Harmony II\nNome da marca: Tekstil\n'.repeat(5);
    const r = await readListingInfo('https://www.amazon.com.br/Pillow-Top/dp/B09Q7JGKR2?ref=x', llm({ title: 'Pillow Top Super Volumosa - Harmony II', brand: 'Tekstil', model: 'Tekstil Harmony II', kind: 'pillow_top' }), async () => page);
    expect(r).toMatchObject({ asin: 'B09Q7JGKR2', link: 'https://www.amazon.com.br/dp/B09Q7JGKR2', brand: 'Tekstil', label: 'Tekstil Harmony II', kind: 'pillow_top', via: 'anúncio', warnings: [] });
    const blocked = async () => { throw new Error('403'); };
    const index = (async () => [{ title: 'Herval Pillow Top Avulso Casal', url: 'https://www.amazon.com.br/dp/B07Y1FZL3K', content: 'Marca Herval, pillow top avulso casal, espuma', score: 1 }]) as never;
    const r2 = await readListingInfo('B07Y1FZL3K', llm({ title: 'Herval Pillow Top Avulso Casal', brand: '', model: 'Pillow Top Avulso', kind: 'outro' }), blocked, index);
    expect(r2.via).toBe('índice de busca');
    expect(r2.warnings.join(' ')).toMatch(/marca/);
    expect(r2.warnings.join(' ')).toMatch(/tipo/);
    await expect(readListingInfo('https://www.amazon.com.br/s?k=x', llm({}))).rejects.toThrow(/código de produto/);
    await expect(readListingInfo('B000000001', llm({}), blocked, (async () => []) as never)).rejects.toThrow(/não consegui ler/);
  });
});
