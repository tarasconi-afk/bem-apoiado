import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-state-'));
process.env.TAVILY_API_KEY = 'test';
delete process.env.BRAVE_API_KEY; // a reserva não pode mascarar o erro testado
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

describe('domínios da busca', () => {
  it('link vira host; o que não é domínio sai', async () => {
    const { cleanDomains } = await import('../src/search.ts');
    expect(cleanDomains(['https://bemapoiado.com/como-escolher-colchao/', 'www.Castor.com.br', 'castor.com.br', 'Castor', '*.gov.br'])).toEqual(['bemapoiado.com', 'castor.com.br', '*.gov.br']);
  });
});
