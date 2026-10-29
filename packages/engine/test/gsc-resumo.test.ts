import { describe, expect, it } from 'vitest';
import { snapshotTotals } from '../src/gsc.ts';

// Editor, 29/10: "quero os números atualizados sem precisar entrar no GSC diariamente". O painel já tinha a
// tabela por página; faltava o resumo e a variação entre os dois últimos retratos.
describe('resumo do retrato do Search Console', () => {
  const snap = (rows: { page: string; query: string; clicks: number; impressions: number; position: number }[]) =>
    ({ site: 's', start: '2026-10-01', end: '2026-10-27', fetched_at: '2026-10-29T11:00:00Z', rows: rows.map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 })) }) as never;

  it('soma cliques e impressões e conta páginas distintas', () => {
    const t = snapshotTotals(snap([
      { page: 'https://x/a/', query: 'q1', clicks: 1, impressions: 10, position: 5 },
      { page: 'https://x/a/', query: 'q2', clicks: 0, impressions: 90, position: 50 },
      { page: 'https://x/b/', query: 'q3', clicks: 2, impressions: 100, position: 10 },
    ]));
    expect(t.clicks).toBe(3);
    expect(t.impressions).toBe(200);
    expect(t.pages).toBe(2);
  });

  // Média simples daria 21,7 e esconderia que quase toda impressão está em posição ruim; a ponderada dá 27,5.
  it('a posição é ponderada por impressão, não média simples', () => {
    const t = snapshotTotals(snap([
      { page: 'https://x/a/', query: 'q1', clicks: 0, impressions: 10, position: 5 },
      { page: 'https://x/a/', query: 'q2', clicks: 0, impressions: 90, position: 30 },
    ]));
    expect(t.position).toBeCloseTo(27.5, 1);
  });

  it('retrato vazio não divide por zero', () => {
    expect(snapshotTotals(snap([])).position).toBe(0);
  });
});
