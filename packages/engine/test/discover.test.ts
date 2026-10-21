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
  });
});
