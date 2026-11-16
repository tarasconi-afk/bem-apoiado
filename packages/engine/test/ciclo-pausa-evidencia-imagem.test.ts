import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Melhorias autorizadas pelo dono em 16/11, a partir do fim de semana de 13–16/11.
const raiz = mkdtempSync(join(tmpdir(), 'bem-1611-'));
mkdirSync(join(raiz, 'data', 'images'), { recursive: true });
writeFileSync(join(raiz, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
process.env.BEM_ROOT = raiz;
process.env.BEM_STATE_DIR = join(raiz, '.state');

const auto = await import('../src/stages/autopilot.ts');
const { pausaHtml } = await import('../src/admin.ts');

describe('pausa de páginas novas com ramos esperando o dono', () => {
  it('conta ramos distintos e pausa a partir de 5', () => {
    expect(auto.pendentesNoAmbiente('a,b,a,,c')).toBe(3);
    expect(auto.pausaDePaginasNovas(4)).toBe(null);
    expect(auto.pausaDePaginasNovas(5)).toMatch(/^pausa de páginas novas: 5 ramos esperando você/);
    expect(auto.pausaDePaginasNovas(9)).toMatch(/só manutenção/);
  });
  it('o painel avisa por que o motor parou de abrir páginas', () => {
    expect(pausaHtml(3)).toBe('');
    expect(pausaHtml(9)).toContain('Pausa de páginas novas: 9 ramos esperando você');
  });
});

describe('pesquisa própria sem evidência não vai para a redação', () => {
  it('0 evidências aceitas para a pauta; qualquer evidência própria segue', () => {
    // 16/11, colchão de espuma para acampamento: discover 0, research 0, rascunho com 67% de enchimento (75,7 créditos).
    expect(auto.semEvidenciaPropria(0)).toBe(true);
    expect(auto.semEvidenciaPropria(1)).toBe(false);
  });
});

describe('imagem que falhou volta nos ciclos seguintes, com limite', () => {
  it('desiste só depois de 3 falhas na janela de 7 dias', () => {
    const agora = Date.parse('2026-11-16T12:00:00Z');
    const f = {
      a: { n: 1, at: '2026-11-15T12:00:00Z' },
      b: { n: 3, at: '2026-11-15T12:00:00Z' },
      c: { n: 3, at: '2026-11-01T12:00:00Z' }, // fora da janela: tenta de novo
    };
    expect(auto.imagensDesistidas(f, agora)).toEqual(['b']);
  });

  it('erro passageiro do provedor ganha segunda chance; erro definitivo não; nenhum derruba as outras', async () => {
    process.env.NEXOS_API_KEY = 'sk-teste-0000000000000000';
    const { ensureImages, imagemFalhaPassageira } = await import('../src/images.ts');
    expect(imagemFalhaPassageira(new Error('imagem x: HTTP 503 upstream connect error'))).toBe(true);
    expect(imagemFalhaPassageira(new Error('terminated'))).toBe(true);
    expect(imagemFalhaPassageira(new Error('imagem x: HTTP 400 bad prompt'))).toBe(false);

    const chamadas: string[] = [];
    const respostas: Record<string, number> = { 'pagina-a': 503, 'pagina-b': 400 };
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      const id = JSON.parse(init.body).prompt.startsWith('A') ? 'pagina-a' : 'pagina-b';
      chamadas.push(id);
      return new Response('falhou', { status: respostas[id]! });
    }) as unknown as typeof fetch;
    const falhas: string[] = [];
    const feitas = await ensureImages(
      raiz, [],
      [{ slug: 'a', title: 'Guia A', status: 'approved' }, { slug: 'b', title: 'Guia B', status: 'approved' }],
      async (s) => ({ alt: 'imagem de teste', prompt: (s.includes('Guia A') ? 'A' : 'B') + ' generic bedroom scene with soft daylight and wooden floor, wide shot' }),
      { fetchImpl, retryDelayMs: 0, onFail: (id) => falhas.push(id) },
    );
    expect(feitas).toEqual([]);
    expect(chamadas).toEqual(['pagina-a', 'pagina-a', 'pagina-b']); // 503 tentou 2x; 400 só 1x
    expect(falhas).toEqual(['pagina-a', 'pagina-b']);
    delete process.env.NEXOS_API_KEY;
  });
});
