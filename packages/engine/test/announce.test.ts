import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-ann-'));

const sitemap = (urls: [string, string][]) => `<?xml version="1.0"?><urlset>${urls.map(([u, d]) => `<url><loc>https://bemapoiado.com/${u}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('')}</urlset>`;

describe('aviso aos buscadores', () => {
  it('lê o sitemap no ar, avisa só o que mudou e guarda o que o IndexNow recusou para tentar de novo', async () => {
    const { announce, parseSitemap, INDEXNOW_KEY } = await import('../src/announce.ts');
    expect(parseSitemap(sitemap([['a/', '2026-10-22'], ['sobre/', '']]))).toEqual({ 'https://bemapoiado.com/a/': '2026-10-22', 'https://bemapoiado.com/sobre/': '' });
    let xml = sitemap([['a/', '2026-10-22'], ['b/', '2026-10-22']]);
    let status = 200;
    const sent: string[][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('sitemap.xml')) return new Response(xml);
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({ host: 'bemapoiado.com', key: INDEXNOW_KEY, keyLocation: `https://bemapoiado.com/${INDEXNOW_KEY}.txt` });
      sent.push(body.urlList);
      return new Response('', { status });
    }) as typeof fetch;
    expect((await announce(f)).sent).toBe(2);
    expect((await announce(f)).changed).toBe(0);
    expect(sent).toHaveLength(1);
    xml = sitemap([['a/', '2026-10-23'], ['b/', '2026-10-22'], ['c/', '2026-10-23']]);
    status = 403;
    const r = await announce(f);
    expect(r).toMatchObject({ changed: 2, sent: 0 });
    expect(r.indexnow).toMatch(/recusado/);
    status = 202;
    expect((await announce(f)).sent).toBe(2);
    expect(sent.at(-1)).toEqual(['https://bemapoiado.com/a/', 'https://bemapoiado.com/c/']);
  });
});
