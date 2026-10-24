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

describe('ajuste que falhou trava o aprovar', () => {
  it('só o último ajuste da página conta', async () => {
    const { failedAdjust } = await import('../src/admin.ts');
    const j = (slug: string, code: number, output: string) => ({ id: 'x', label: 'l', args: ['ajustar', 'main', slug, 'f'], started: '', ended: 'e', code, output });
    expect(failedAdjust([j('a', 1, 'erro\najuste NÃO salvo (veja o motivo acima)')] as never, 'a')).toContain('NÃO salvo');
    expect(failedAdjust([j('a', 0, 'texto ajustado'), j('a', 1, 'ajuste NÃO salvo')] as never, 'a')).toBeNull();
    expect(failedAdjust([j('b', 1, 'ajuste NÃO salvo')] as never, 'a')).toBeNull();
    // ajuste salvo depois da falha (commit "Painel: ajuste em …" mais novo) apaga o aviso
    const t = (slug: string, ended: string) => ({ id: 'x', label: 'l', args: ['ajustar', 'main', slug, 'f'], started: '', ended, code: 1, output: 'ajuste NÃO salvo' });
    expect(failedAdjust([t('a', '2026-10-24T15:56:56Z')] as never, 'a', Date.parse('2026-10-24T16:20:00Z'))).toBeNull();
    expect(failedAdjust([t('a', '2026-10-24T15:56:56Z')] as never, 'a', Date.parse('2026-10-24T15:00:00Z'))).toContain('NÃO salvo');
  });
});

describe('aviso de anúncio suspeito', () => {
  it('título com outra marca ou sem a marca informada', async () => {
    const { listingWarnings } = await import('../src/stages/products.ts');
    const u = 'https://www.amazon.com.br/Escritorio-Ergonomica-Escrit%C3%B3rio-Escrivaninha-Flexform/dp/B0D8BHB5KG?tag=x';
    expect(listingWarnings(u, 'Namoat', ['Flexform', 'XT Racer']).join(' ')).toContain('cita Flexform');
    expect(listingWarnings(u, 'Namoat', ['Flexform']).join(' ')).toContain('não cita Namoat');
    expect(listingWarnings('https://www.amazon.com.br/XT-Racer-Cadeira-Platinum/dp/B0DHF6Q2T7', 'XT Racer', ['Flexform', 'XT Racer'])).toEqual([]);
    expect(listingWarnings('https://www.amazon.com.br/dp/B0DHF6Q2T7', 'XT Racer', ['Flexform'])).toEqual([]);
  });
});
