import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-cited-'));
process.env.BEM_ROOT = root;
mkdirSync(join(root, 'data'), { recursive: true });

describe('link pelo nome do modelo citado', () => {
  it('grava os modelos, tira medida, pula linha genérica e modelo que já tem anúncio, no máximo 3', async () => {
    const { citedSearchLinks, loadCitedModels, saveCitedModels } = await import('../src/stages/cited.ts');
    saveCitedModels('casal', [
      { brand: 'Probel', model: 'Guarda Costas', kind: 'espuma' },
      { brand: 'Probel', model: 'Firmpedic PróExtreme', kind: 'espuma' },
      { brand: 'Simmons', model: 'Pillow Top', kind: 'molas_ensacadas' },
      { brand: 'Probel', model: 'Excede Premium Casal', kind: 'misto' },
      { brand: 'Ortobom', model: 'Orion Casal', kind: 'molas_ensacadas' },
      { brand: 'Gazin', model: 'Twins', kind: 'molas_ensacadas' },
    ]);
    expect(loadCitedModels().pages.casal!.models).toHaveLength(6);
    const catalog = [{ brand: 'Probel', label: 'Probel Firmpedic PróExtreme D45' }];
    expect(citedSearchLinks('casal', catalog)).toEqual([
      { label: 'Ver Probel Guarda Costas na Amazon', query: 'Probel Guarda Costas' },
      { label: 'Ver Probel Excede Premium na Amazon', query: 'Probel Excede Premium' },
      { label: 'Ver Ortobom Orion na Amazon', query: 'Ortobom Orion' },
    ]);
    expect(citedSearchLinks('sem-registro', catalog)).toEqual([]);
  });
});
