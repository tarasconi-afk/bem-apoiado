import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-links-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data/niche.json'), readFileSync(join(import.meta.dirname, '../../../data/niche.json')));
writeFileSync(join(root, 'data/link-anchors.json'), JSON.stringify({ pages: { 'colchao-d28-ou-d33': { anchors: ['densidade'], model: 'm', at: '2026-10-20' } } }));

const page = (slug: string, status = 'approved') => ({ slug, status, primary_query: slug.replace(/-/g, ' '), title: `Título de ${slug}`, sections: [{ id: 's', heading: 'Seção', blocks: [] }] });

describe('âncoras de links internos', () => {
  it('só páginas no ar sem âncora; descarta genérica, repetida e já usada por outra página', async () => {
    const asked: string[] = [];
    const llm = async (_u: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)).messages[1].content);
      const anchors = ['Molas Ensacadas', 'molas  ensacadas', 'colchão', 'densidade', 'colchão de molas'];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ anchors }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    };
    const { ensureAnchors } = await import('../src/stages/links.ts');
    const done = await ensureAnchors([page('colchao-d28-ou-d33'), page('colchao-de-molas-ou-espuma'), page('rascunho', 'draft')] as never, llm);
    expect(done).toEqual(['colchao-de-molas-ou-espuma']);
    expect(asked).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(root, 'data/link-anchors.json'), 'utf8'));
    expect(saved.pages['colchao-de-molas-ou-espuma'].anchors).toEqual(['molas ensacadas', 'colchão de molas']);
    expect(saved.pages['colchao-d28-ou-d33'].anchors).toEqual(['densidade']);
  });
});
