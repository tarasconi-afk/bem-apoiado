import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-cited-'));
process.env.BEM_ROOT = root;
mkdirSync(join(root, 'data'), { recursive: true });
// O nicho real: é dele que sai o substantivo do tipo que entra na busca.
copyFileSync(join(process.cwd(), 'data', 'niche.json'), join(root, 'data', 'niche.json'));

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
      { label: 'Ver Probel Guarda Costas na Amazon', query: 'Probel Guarda Costas Colchão' },
      { label: 'Ver Probel Excede Premium na Amazon', query: 'Probel Excede Premium Colchão' },
      { label: 'Ver Ortobom Orion na Amazon', query: 'Ortobom Orion Colchão' },
    ]);
    expect(citedSearchLinks('sem-registro', catalog)).toEqual([]);
  });

  // 29/10, guia da toalha: "Ver Sultan Max na Amazon" abria uma lista de PERFUMES. O tipo estava gravado no
  // modelo citado (kind: "toalha") e não entrava na busca: marca e modelo iam soltos e o acaso escolhia a
  // categoria. O link é a última coisa que o leitor faz antes de comprar; cair em perfume mata a página.
  it('a busca leva o tipo do produto, e não repete a palavra quando o nome já a tem', async () => {
    const { citedSearchLinks, saveCitedModels } = await import('../src/stages/cited.ts');
    saveCitedModels('toalhas', [
      { brand: 'Sultan', model: 'Max', kind: 'toalha' },
      { brand: 'Teka', model: 'Toalha Monaco', kind: 'toalha' },
      { brand: 'Ortobom', model: 'Orion', kind: 'molas_ensacadas' },
    ]);
    expect(citedSearchLinks('toalhas', [])).toEqual([
      { label: 'Ver Sultan Max na Amazon', query: 'Sultan Max Toalha' },
      { label: 'Ver Teka Toalha Monaco na Amazon', query: 'Teka Toalha Monaco' }, // já diz o tipo
      { label: 'Ver Ortobom Orion na Amazon', query: 'Ortobom Orion Colchão' }, // só o substantivo do rótulo
    ]);
  });
});
