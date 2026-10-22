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

describe('padrão da ilustração de anúncio', () => {
  it('sem marca, com cena e ângulo; anúncios do mesmo tipo em cômodos diferentes', async () => {
    const { productSubject, wantedImages } = await import('../src/images.ts');
    const sub = productSubject('Cadeira', 'XT Racer Platinum W Cadeira Gamer Marrom', 'XT Racer', 'cozy study', 'side view');
    expect(sub).not.toContain('XT Racer');
    expect(sub).toContain('Cena: cozy study');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'img-'));
    mkdirSync(join(root, 'data/images'), { recursive: true });
    writeFileSync(join(root, 'data/images/registry.json'), '[]');
    const prods = ['B01', 'B02', 'B03'].map((asin) => ({ asin, kind: 'cadeira', brand: 'X', label: 'X Cadeira' }));
    const w = wantedImages(root, [], [], prods).map((x) => /Cena: ([^.]+)\./.exec(x.subject)![1]);
    expect(new Set(w).size).toBe(3);
    const bed = wantedImages(root, [], [], [{ asin: 'B09', kind: 'espuma', brand: 'X', label: 'X Colchão' }])[0]!.subject;
    expect(bed).toMatch(/Cena: [^.]*bedroom/);
  });
});
