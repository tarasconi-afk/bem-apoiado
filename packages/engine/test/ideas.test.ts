import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-ideas-'));
process.env.BEM_ROOT = root;
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
mkdirSync(join(root, 'data/topics'), { recursive: true });
writeFileSync(join(root, 'data/niche.json'), readFileSync(join(import.meta.dirname, '../../../data/niche.json')));
process.env.NEXOS_API_KEY = 'k';

describe('descoberta de pautas', () => {
  it('coleta no autocompletar, filtra saúde, triagem reescreve e agrupa a mesma intenção', async () => {
    const google = (async (url: string) => {
      const q = decodeURIComponent(String(url).split('q=')[1]!);
      const list = q.startsWith('travesseiro qual') ? ['travesseiro qual o melhor', 'travesseiro qual melhor marca', 'travesseiro qual o melhor para dor no pescoço'] : q.startsWith('como escolher travesseiro') ? ['como escolher travesseiro'] : [];
      return new Response(JSON.stringify([q, list]));
    }) as typeof fetch;
    let sent = '';
    const llm = async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).messages[1].content;
      const lines = sent.split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
      const asked = lines.slice(lines.indexOf('Buscas para avaliar:') + 1);
      const items = asked.map((t, i) => ({ n: i + 1, keep: !t.includes('marca'), query: t.includes('melhor') || t.startsWith('como') ? 'como escolher travesseiro' : t, same_as: null, reason: 'decisão' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    };
    const { discoverIdeas, promoteIdeas } = await import('../src/stages/ideas.ts');
    const r = await discoverIdeas(google, llm);
    expect(sent).not.toContain('dor no pescoço');
    expect(r.added.map((i) => i.query)).toEqual(['como escolher travesseiro']);
    expect(r.added[0]!.from).toHaveLength(2);
    const queued: string[] = [];
    expect(promoteIdeas((q) => (queued.push(q), true), 5)).toEqual(['como escolher travesseiro']);
    const again = await discoverIdeas(google, llm);
    expect(again.added).toEqual([]);
  });
});
