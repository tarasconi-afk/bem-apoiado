import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-quota-'));
process.env.TAVILY_API_KEY = 'test';
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
