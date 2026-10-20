import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-state-'));
process.env.TAVILY_API_KEY = 'test';
process.env.TAVILY_MONTHLY_CAP = '2';

describe('webSearch', () => {
  it('conta créditos e recusa acima do teto mensal sem chamar a rede', async () => {
    const { webSearch, creditsThisMonth } = await import('../src/search.ts');
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x.test', content: 'c', score: 0.9 }], usage: { credits: 1 } }));
    }) as unknown as typeof fetch;
    await webSearch('a', {}, f);
    await webSearch('b', {}, f);
    expect(creditsThisMonth()).toBe(2);
    await expect(webSearch('c', {}, f)).rejects.toMatchObject({ code: 'MONTHLY_CAP' });
    expect(calls).toBe(2);
  });
});
