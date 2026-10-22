import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-auto-'));
process.env.BEM_ROOT = root;

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/queue.json'), JSON.stringify({
    items: [
      { query: 'Travesseiro alto ou baixo', added_at: '2026-10-20' },
      { query: 'Cadeira ergonômica ou gamer', added_at: '2026-10-20' },
    ],
  }));
});

describe('nextQuery', () => {
  it('pula pauta com PR do motor ainda aberto', async () => {
    const { nextQuery } = await import('../src/stages/autopilot.ts');
    expect(nextQuery()).toBe('Travesseiro alto ou baixo');
    process.env.BEM_PENDING_SLUGS = 'travesseiro-alto-ou-baixo';
    expect(nextQuery()).toBe('Cadeira ergonômica ou gamer');
    delete process.env.BEM_PENDING_SLUGS;
  });
});

describe('pauta sem fabricantes cadastrados', () => {
  it('tipo com menos de 2 fabricantes não anda; sem tipo reconhecido não bloqueia', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = process.env.BEM_ROOT!;
    mkdirSync(join(root, 'data/registry'), { recursive: true });
    writeFileSync(join(root, 'data/registry/domains.json'), JSON.stringify({ allow: [
      { host: 'a.com.br', publisher: 'A', source_class: 'manufacturer', kinds: ['cadeira'] },
      { host: 'b.com.br', publisher: 'B', source_class: 'manufacturer', kinds: ['cadeira'] },
      { host: 'c.com.br', publisher: 'C', source_class: 'manufacturer', kinds: ['mesa'] },
    ], block: [] }));
    const { lacksMakers } = await import('../src/stages/autopilot.ts');
    const topic = (kinds: string[]) => ({ product_kinds: kinds }) as never;
    expect(lacksMakers('x', topic(['mesa']))).toBe(true);
    expect(lacksMakers('x', topic(['cadeira']))).toBe(false);
    expect(lacksMakers('x', topic(['mesa', 'cadeira']))).toBe(false);
  });
});

describe('teto diário e ciclo manual', () => {
  it('manual com menos de 20 páginas no ar não tem teto diário; automático e manual a partir de 20 têm', async () => {
    const { dailyCapFor, DAILY_CREDIT_CAP } = await import('../src/stages/autopilot.ts');
    expect(dailyCapFor(true, 12)).toBe(Number.POSITIVE_INFINITY);
    expect(dailyCapFor(false, 12)).toBe(DAILY_CREDIT_CAP);
    expect(dailyCapFor(true, 20)).toBe(DAILY_CREDIT_CAP);
  });
});
