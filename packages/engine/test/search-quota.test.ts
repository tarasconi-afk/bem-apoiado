import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-quota-'));
process.env.TAVILY_API_KEY = 'test';
delete process.env.BRAVE_API_KEY; // a reserva não pode mascarar o erro testado
process.env.TAVILY_MONTHLY_CAP = '100';

describe('cota do plano Tavily', () => {
  it('cota esgotada é teto (para a descoberta), não "busca sem resultado"; outro erro HTTP segue como HTTP', async () => {
    const { webSearch } = await import('../src/search.ts');
    const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    await expect(webSearch('a', {}, reply(432, '{"detail":"This request exceeds your plan\'s set usage limit"}'))).rejects.toMatchObject({ code: 'MONTHLY_CAP' });
    await expect(webSearch('a', {}, reply(433, 'pay as you go limit'))).rejects.toMatchObject({ code: 'MONTHLY_CAP' });
    await expect(webSearch('a', {}, reply(429, 'usage limit exceeded'))).rejects.toMatchObject({ code: 'MONTHLY_CAP' });
    await expect(webSearch('a', {}, reply(429, 'too many requests'))).rejects.toMatchObject({ code: 'HTTP' });
    await expect(webSearch('a', {}, reply(500, 'erro'))).rejects.toMatchObject({ code: 'HTTP' });
  });
});

describe('Brave como reserva da Tavily', () => {
  it('cota da Tavily esgotada: a Brave responde, com site: e filtro de domínio; erro 4xx comum não troca de buscador', async () => {
    const { webSearch, braveThisMonth } = await import('../src/search.ts');
    process.env.BRAVE_API_KEY = 'brave-test';
    const asked: string[] = [];
    const f = (async (url: string) => {
      if (url.startsWith('https://api.tavily.com')) return new Response('{"detail":"usage limit"}', { status: 432 });
      asked.push(url);
      return new Response(JSON.stringify({ web: { results: [
        { title: 'Ficha <strong>Probel</strong>', url: 'https://www.probel.com.br/colchao-x', description: 'Densidade D33 &amp; molas' },
        { title: 'Loja', url: 'https://loja.com.br/colchao', description: 'oferta' },
      ] } }));
    }) as unknown as typeof fetch;
    const r = await webSearch('colchão densidade', { includeDomains: ['probel.com.br'] }, f);
    expect(r).toEqual([{ title: 'Ficha Probel', url: 'https://www.probel.com.br/colchao-x', content: 'Densidade D33 & molas', score: 0.9 }]);
    expect(decodeURIComponent(asked[0]!)).toContain('site:probel.com.br');
    expect(braveThisMonth()).toBe(1);
    const bad = (async (url: string) => (url.startsWith('https://api.tavily.com') ? new Response('bad request', { status: 400 }) : new Response('{}'))) as unknown as typeof fetch;
    await expect(webSearch('x', {}, bad)).rejects.toMatchObject({ code: 'HTTP' });
    delete process.env.BRAVE_API_KEY;
  });
});
