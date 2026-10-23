import { describe, expect, it } from 'vitest';
import { classify } from '../src/stages/discover.ts';

const reg = {
  allow: [
    { host: 'gov.br', path: '/inmetro', publisher: 'Inmetro', source_class: 'regulator' as const },
    { host: 'probel.com.br', publisher: 'Probel', source_class: 'manufacturer' as const },
  ],
  block: ['youtube.com', 'buscape.com.br'],
};

describe('classify', () => {
  it('aceita só domínio e caminho cadastrados', () => {
    expect(classify('https://www.gov.br/inmetro/pt-br/x', reg)).toEqual({ publisher: 'Inmetro', source_class: 'regulator' });
    expect(classify('https://blog.probel.com.br/post', reg)).toMatchObject({ publisher: 'Probel' });
  });
  it('gov.br de outro órgão não entra sozinho', () => {
    expect(classify('https://www.gov.br/receitafederal/x', reg)).toBe('unknown');
  });
  it('bloqueia vídeo e comparador, inclusive subdomínio', () => {
    expect(classify('https://m.youtube.com/watch?v=1', reg)).toBe('blocked');
    expect(classify('https://www.buscape.com.br/x', reg)).toBe('blocked');
  });
  it('não confunde domínio parecido', () => {
    expect(classify('https://probel.com.br.golpe.net/x', reg)).toBe('unknown');
  });
});

import { mkdirSync as mkd, mkdtempSync as mkt, readFileSync as rf, writeFileSync as wf } from 'node:fs';
import { tmpdir as tmpd } from 'node:os';
import { join as j } from 'node:path';
describe('cadastro de domínios pelo painel', () => {
  it('candidatos agregam por domínio fora do cadastro; aprovar e bloquear gravam e não duplicam', async () => {
    const runs = mkt(j(tmpd(), 'bem-runs-'));
    mkd(j(runs, 'r1'), { recursive: true });
    wf(j(runs, 'r1', 'discover.json'), JSON.stringify({ topic: 'mesa', suggestions: [{ host: 'www.mesasx.com.br', url: 'https://www.mesasx.com.br/a', title: 'Mesa X' }, { host: 'gov.br', url: 'https://gov.br/x', title: 'gov' }] }));
    const { domainCandidates, editRegistry } = await import('../src/stages/discover.ts');
    const c = domainCandidates(runs, { allow: [{ host: 'gov.br', publisher: 'G', source_class: 'regulator' }], block: [] } as never);
    expect(c.map((x) => x.host)).toEqual(['mesasx.com.br']);
    expect(() => editRegistry('allow', 'nao é domínio', 'X', 'manufacturer')).toThrow();
    expect(() => editRegistry('allow', 'gov.br', 'Gov', 'regulator', j(runs, 'x.json'))).toThrow(/sufixo público/);
    const regFile = j(runs, 'domains.json');
    wf(regFile, JSON.stringify({ allow: [], block: [] }));
    expect(editRegistry('allow', 'www.MesasX.com.br', 'Mesas X', 'manufacturer', regFile)).toBe(true);
    expect(editRegistry('allow', 'mesasx.com.br', 'Mesas X', 'manufacturer', regFile)).toBe(false);
    expect(editRegistry('block', 'loja.com.br', undefined, undefined, regFile)).toBe(true);
    const saved = JSON.parse(rf(regFile, 'utf8'));
    expect(saved.allow).toEqual([{ host: 'mesasx.com.br', publisher: 'Mesas X', source_class: 'manufacturer' }]);
    expect(saved.block).toEqual(['loja.com.br']);
    wf(j(runs, 'r1', 'discover.json'), JSON.stringify({ topic: 'x', suggestions: [{ host: 'licitacao.maceio.al.gov.br', url: 'https://licitacao.maceio.al.gov.br/a', title: 'Pregão' }] }));
    expect(domainCandidates(runs, { allow: [], block: [] } as never)).toEqual([]);
    // Só vira sugestão o domínio com página sobre o produto (23/10: artigos de ERP sobre "o que é ficha técnica").
    wf(j(runs, 'r1', 'discover.json'), JSON.stringify({ topic: 'x', suggestions: [
      { host: 'korp.com.br', url: 'https://korp.com.br/ficha-tecnica', title: 'Ficha Técnica: O Que É, Como Fazer e Modelos na Indústria' },
      { host: 'colchoesy.com.br', url: 'https://colchoesy.com.br/sobre', title: 'Sobre nós' },
      { host: 'colchoesy.com.br', url: 'https://colchoesy.com.br/linha', title: 'Colchão de espuma D33' },
    ] }));
    const only = domainCandidates(runs, { allow: [], block: [] } as never, ['colchao', 'espuma']);
    expect(only.map((x) => [x.host, x.example.title])).toEqual([['colchoesy.com.br', 'Colchão de espuma D33']]);
  });
});

describe('fabricantes por tipo', () => {
  it('pauta de cadeira mira só quem faz cadeira', async () => {
    const { makersFor } = await import('../src/stages/discover.ts');
    const r = {
      allow: [
        { host: 'probel.com.br', publisher: 'Probel', source_class: 'manufacturer' as const, kinds: ['espuma', 'travesseiro'] },
        { host: 'cavaletti.com.br', publisher: 'Cavaletti', source_class: 'manufacturer' as const, kinds: ['cadeira'] },
        { host: 'gov.br', path: '/inmetro', publisher: 'Inmetro', source_class: 'regulator' as const },
      ],
      block: [],
    };
    expect(makersFor(['cadeira'], r).map((m) => m.publisher)).toEqual(['Cavaletti']);
    expect(makersFor(['mesa'], r)).toEqual([]);
  });
});

describe('buscas por fabricante', () => {
  it('busca com vários sites juntos não conta como busca no site de cada um', async () => {
    const { makerQueries } = await import('../src/stages/discover.ts');
    const makers = [{ host: 'a.com.br' }, { host: 'b.com.br' }, { host: 'c.com.br' }, { host: 'd.com.br' }];
    const planned = [{ q: 'x', include_domains: ['a.com.br', 'b.com.br', 'c.com.br'] }, { q: 'y', include_domains: ['b.com.br'] }];
    expect(makerQueries(planned, makers, 'cadeira').map((q) => q.include_domains[0])).toEqual(['a.com.br', 'c.com.br', 'd.com.br']);
  });
});

describe('sites já buscados sozinhos', () => {
  it('conta só busca de um site, só desta pauta', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { searchedAlone } = await import('../src/stages/discover.ts');
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const put = (run: string, v: unknown) => { mkdirSync(join(dir, run)); writeFileSync(join(dir, run, 'discover.json'), JSON.stringify(v)); };
    put('r1', { topic: 'cadeira', queries: [{ include_domains: ['a.com.br'] }, { include_domains: ['b.com.br', 'c.com.br'] }, {}] });
    put('r2', { topic: 'outra', queries: [{ include_domains: ['d.com.br'] }] });
    expect([...searchedAlone(dir, 'cadeira')]).toEqual(['a.com.br']);
  });
});

describe('ordem dos fabricantes', () => {
  it('citado no pedido, depois nunca buscado, depois já buscado, por último os que já têm fonte', async () => {
    const { orderMakers } = await import('../src/stages/discover.ts');
    const m = (publisher: string, host: string) => ({ publisher, host });
    const makers = [m('Flexform', 'flexform.com.br'), m('Frisokar', 'frisokar.com.br'), m('Funcional', 'funcional.com.br'), m('XT Racer', 'xtracer.com.br'), m('ThunderX3', 'thunderx3.com.br')];
    const out = orderMakers(makers, { named: 'Pesquise na XT Racer e na ThunderX3', withEvidence: new Set(['Flexform']), tried: new Set(['frisokar.com.br']) });
    expect(out.map((x) => x.publisher)).toEqual(['XT Racer', 'ThunderX3', 'Funcional', 'Frisokar', 'Flexform']);
    // citar a marca que já é fonte não a põe na frente
    const again = orderMakers(makers, { named: 'usa quase só a Flexform; pesquise na XT Racer', withEvidence: new Set(['Flexform']), tried: new Set() });
    expect(again[0]!.publisher).toBe('XT Racer');
    expect(again.at(-1)!.publisher).toBe('Flexform');
  });
});

describe('site que bloqueia a VPS', () => {
  it('403 tenta pela Tavily; outro erro não', async () => {
    const { snapshotOrTavily } = await import('../src/stages/discover.ts');
    const calls: (string | undefined)[] = [];
    const snap = (async (i: { url: string; via?: string }) => {
      calls.push(i.via);
      if (!i.via) throw new Error(i.url.includes('bloq') ? `HTTP 403 em ${i.url}` : `HTTP 404 em ${i.url}`);
      return { source: { id: 'src_x' }, created: true };
    }) as never;
    const base = { publisher: 'XT Racer', sourceClass: 'manufacturer' as const };
    expect((await snapshotOrTavily({ url: 'https://bloq.com.br/a', ...base }, snap)).source.id).toBe('src_x');
    expect(calls).toEqual([undefined, 'tavily']);
    await expect(snapshotOrTavily({ url: 'https://x.com.br/a', ...base }, snap)).rejects.toThrow('404');
  });
});
