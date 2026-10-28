import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-quota-'));
process.env.TAVILY_API_KEY = 'test';
delete process.env.BRAVE_API_KEY; // a reserva não pode mascarar o erro testado
process.env.TAVILY_MONTHLY_CAP = '100';

// 432 e 433 queimam a chave no mês (ver PLANO_ESGOTADO), então cada caso de classificação começa limpo.
const zera = () => {
  rmSync(join(process.env.BEM_STATE_DIR!, 'tavily-usage-by-key.json'), { force: true });
  rmSync(join(process.env.BEM_STATE_DIR!, 'tavily-keys.json'), { force: true });
};

describe('cota do plano Tavily', () => {
  it('cota esgotada é teto (para a descoberta), não "busca sem resultado"; outro erro HTTP segue como HTTP', async () => {
    const { webSearch } = await import('../src/search.ts');
    const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const caso = async (status: number, body: string, code: string) => {
      zera();
      await expect(webSearch('a', {}, reply(status, body))).rejects.toMatchObject({ code });
    };
    await caso(432, '{"detail":"This request exceeds your plan\'s set usage limit"}', 'MONTHLY_CAP');
    await caso(433, 'pay as you go limit', 'MONTHLY_CAP');
    await caso(429, 'usage limit exceeded', 'MONTHLY_CAP');
    await caso(429, 'too many requests', 'HTTP');
    await caso(500, 'erro', 'HTTP');
    zera();
  });
});

// 28/10, decisão do editor: o plano grátis de uma conta não cobre o ritmo do motor, e abrir outra conta com outro
// email funcionou no Ferramenta Clara. O motor usa uma chave por vez e só cai no Brave quando TODAS acabarem.
describe('várias chaves Tavily', () => {
  it('a chave do env vem primeiro e as cadastradas entram depois', async () => {
    zera();
    const { tavilyKeys, addTavilyKey } = await import('../src/search.ts');
    expect(tavilyKeys().map((k) => k.id)).toEqual(['env']);
    const nova = addTavilyKey('tvly-dev-abcdefghij1234567890', 'segunda conta');
    expect(typeof nova).not.toBe('string');
    expect(tavilyKeys().map((k) => k.id)[0]).toBe('env');
    expect(tavilyKeys()).toHaveLength(2);
    zera();
  });

  it('recusa chave com cara errada e chave repetida, em vez de guardar lixo', async () => {
    zera();
    const { addTavilyKey } = await import('../src/search.ts');
    expect(addTavilyKey('abc123', 'x')).toContain('tvly-');
    addTavilyKey('tvly-dev-abcdefghij1234567890', 'primeira');
    expect(addTavilyKey('tvly-dev-abcdefghij1234567890', 'de novo')).toContain('já está cadastrada');
    zera();
  });

  it('cota estourada numa conta: a próxima assume na mesma busca', async () => {
    zera();
    const { webSearch, addTavilyKey, usageByKey } = await import('../src/search.ts');
    addTavilyKey('tvly-dev-segundachave0987654321', 'segunda conta');
    const usadas: string[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      usadas.push(auth);
      if (auth.includes('test')) return new Response('{"detail":"usage limit"}', { status: 432 });
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x.com', content: 'c', score: 1 }], usage: { credits: 1 } }));
    }) as unknown as typeof fetch;
    const r = await webSearch('colchão', {}, f);
    expect(r).toHaveLength(1);
    expect(usadas).toHaveLength(2); // tentou a primeira, caiu, usou a segunda
    expect(usageByKey().env).toBe(100); // queimada no mês
    zera();
  });

  it('a chave nunca aparece inteira no painel', async () => {
    const { maskKey } = await import('../src/search.ts');
    expect(maskKey('tvly-dev-abcdefghij1234567890')).toBe('…7890');
    expect(maskKey('tvly-dev-abcdefghij1234567890')).not.toContain('abcdefghij');
  });
});

describe('Brave como reserva da Tavily', () => {
  it('cota da Tavily esgotada: a Brave responde, com site: e filtro de domínio; erro 4xx comum não troca de buscador', async () => {
    zera();
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
    zera();
    const bad = (async (url: string) => (url.startsWith('https://api.tavily.com') ? new Response('bad request', { status: 400 }) : new Response('{}'))) as unknown as typeof fetch;
    await expect(webSearch('x', {}, bad)).rejects.toMatchObject({ code: 'HTTP' });
    delete process.env.BRAVE_API_KEY;
    zera();
  });
});
