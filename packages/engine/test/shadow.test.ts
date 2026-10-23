import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-shadow-'));

describe('modo sombra', () => {
  it('grava decisões, conta uma por resultado e só fica pronto com 9 de 10, nenhum "publicaria errado" e 14 dias', async () => {
    const { recordShadow, loadShadow, shadowStats } = await import('../src/shadow.ts');
    const day = (d: number) => new Date(Date.UTC(2026, 9, 1 + d, 12)).toISOString();
    for (let i = 0; i < 9; i++) recordShadow({ at: day(i * 2), card: 'pagina-nova', slug: `p${i}`, ramo: `pagina/p${i}`, motor: 'publicar', editor: 'aceitou' });
    recordShadow({ at: day(18), card: 'ajuste-no-ar', slug: 'x', ramo: 'pagina/x', motor: 'corrigir', editor: 'corrigiu' });
    recordShadow({ at: day(18), card: 'ajuste-no-ar', slug: 'x', ramo: 'pagina/x', motor: 'corrigir', editor: 'corrigiu' }); // clique repetido
    const now = new Date(Date.UTC(2026, 9, 20, 12));
    const ok = shadowStats(loadShadow(), now);
    expect([ok.total, ok.agree, ok.wouldPublishWrong.length, ok.ready]).toEqual([10, 10, 0, true]);
    recordShadow({ at: day(19), card: 'pagina-nova', slug: 'y', ramo: 'pagina/y', motor: 'publicar', editor: 'recusou' });
    const bad = shadowStats(loadShadow(), now);
    expect(bad.ready).toBe(false);
    expect(bad.wouldPublishWrong.map((e) => e.slug)).toEqual(['y']);
    expect(bad.missing.join(' ')).toMatch(/publicaria algo que você corrigiu ou recusou/);
    // Poucos dias: não vale uma tarde de cliques.
    const quick = shadowStats(loadShadow().map((e) => ({ ...e, at: now.toISOString() })), now);
    expect(quick.missing.join(' ')).toMatch(/cobrem 0 dia/);
  });
});
