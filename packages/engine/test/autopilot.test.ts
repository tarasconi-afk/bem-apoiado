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
