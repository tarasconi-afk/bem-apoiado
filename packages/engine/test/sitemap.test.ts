import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-sm-'));

describe('mapa do site do fabricante', () => {
  it('lê robots → índice → filhos (produto primeiro), guarda 7 dias e escolhe pelas palavras do endereço', async () => {
    const { siteUrls, rankUrls, topicTerms, phraseTerms } = await import('../src/sitemap.ts');
    const pages: Record<string, string> = {
      'https://castor.ind.br/robots.txt': 'User-agent: *\nSitemap: https://castor.ind.br/sitemap_index.xml',
      'https://castor.ind.br/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://castor.ind.br/image-sitemap.xml</loc></sitemap><sitemap><loc>https://castor.ind.br/product-sitemap.xml</loc></sitemap></sitemapindex>',
      'https://castor.ind.br/product-sitemap.xml': '<urlset><url><loc>https://castor.ind.br/colchao-pillow-top-casal-d33</loc></url><url><loc>https://castor.ind.br/colchao-molas-ensacadas</loc></url><url><loc>https://castor.ind.br/carrinho/</loc></url><url><loc>https://castor.ind.br/blog/como-escolher-pillow-top</loc></url></urlset>',
      'https://castor.ind.br/image-sitemap.xml': '<urlset><url><loc>https://castor.ind.br/x.jpg</loc></url></urlset>',
    };
    let calls = 0;
    const f = (async (u: string) => { calls++; return pages[u] ? new Response(pages[u]) : new Response('', { status: 404 }); }) as unknown as typeof fetch;
    const urls = await siteUrls('castor.ind.br', f, new Date('2026-10-23T12:00:00Z'));
    expect(urls).toContain('https://castor.ind.br/colchao-pillow-top-casal-d33');
    const before = calls;
    await siteUrls('castor.ind.br', f, new Date('2026-10-26T12:00:00Z'));
    expect(calls).toBe(before); // do cache
    const picked = rankUrls(urls, [...topicTerms(['pillow top: o que é e vale a pena', 'pillow top']), ...phraseTerms(['pillow top'])], topicTerms(['Colchão de espuma', 'Qual altura do pillow top']), 3);
    expect(picked.map((p) => p.url).sort()).toEqual(['https://castor.ind.br/blog/como-escolher-pillow-top', 'https://castor.ind.br/colchao-pillow-top-casal-d33']);
    expect(rankUrls(urls, ['colchao'], [], 3)).toEqual([]); // uma palavra só não basta
  });
});
