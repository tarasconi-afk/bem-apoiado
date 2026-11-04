import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-enrich-'));
process.env.BEM_ROOT = root;
process.env.BEM_STATE_DIR = join(root, 'state');
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
const { enrichWaits, ENRICH_GAP_WITH_QUEUE } = await import('../src/stages/autopilot.ts');

// 03–04/11: os ciclos das 22h e das 4h gastaram 56,7 e 57,1 de 60 créditos reescrevendo páginas no ar e a pauta da
// cama box, no topo da fila, esperou as duas vezes ("restam 3 créditos no teto").
describe('enriquecimento não trava a fila', () => {
  const NOW = Date.parse('2026-11-04T07:05:00Z');
  const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

  it('com pauta esperando, só um enriquecimento a cada 24 h (o das 4h espera o das 22h)', () => {
    expect(enrichWaits({ 'algodao-egipcio-vale-a-pena': h(6) }, NOW, () => true)).toBe(true);
    expect(enrichWaits({ 'algodao-egipcio-vale-a-pena': h(25) }, NOW, () => true)).toBe(false);
    expect(ENRICH_GAP_WITH_QUEUE).toBe(24 * 3_600_000);
  });

  it('sem pauta na fila, enriquece à vontade; sem histórico, enriquece', () => {
    expect(enrichWaits({ 'algodao-egipcio-vale-a-pena': h(6) }, NOW, () => false)).toBe(false);
    expect(enrichWaits({}, NOW, () => true)).toBe(false);
  });

  it('só consulta a fila quando houve enriquecimento recente', () => {
    let asked = 0;
    enrichWaits({ x: h(30) }, NOW, () => { asked++; return true; });
    expect(asked).toBe(0);
  });
});
