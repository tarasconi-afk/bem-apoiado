import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wantedImages } from '../src/images.ts';

describe('imagens no piloto automático', () => {
  it('pede imagem para tipo sem registro e capa para página aprovada, nunca para rascunho', () => {
    const root = mkdtempSync(join(tmpdir(), 'bem-img-'));
    mkdirSync(join(root, 'data/images'), { recursive: true });
    writeFileSync(join(root, 'data/images/registry.json'), JSON.stringify([
      { id: 'espuma', kind: 'espuma', file: 'x', alt: 'imagem de teste', width: 1, height: 1, model: 'm', quality: 'medium', prompt: 'p', credits: 5, sha256: 'a', created_at: '2026-10-21T00:00:00.000Z', license: 'l' },
    ]));
    const w = wantedImages(
      root,
      [{ id: 'espuma', label: 'Colchão de espuma' }, { id: 'boneca', label: 'Boneca' }],
      [{ slug: 'a', title: 'Guia A', status: 'approved' }, { slug: 'b', title: 'Guia B', status: 'draft' }],
    );
    expect(w.map((x) => x.id)).toEqual(['boneca', 'pagina-a']);
    expect(w[0]!.kind).toBe('boneca');
  });
});
