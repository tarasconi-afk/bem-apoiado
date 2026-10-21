import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-reuse-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
for (const d of ['topics', 'claims', 'sources']) mkdirSync(join(root, 'data', d), { recursive: true });
writeFileSync(join(root, 'data/niche.json'), readFileSync(join(import.meta.dirname, '../../../data/niche.json')));
const topic = (slug: string, kinds: string[], srcs: string[], q: string) => ({ slug, primary_query: slug.replace(/-/g, ' '), page_type: 'decision_compare', questions: [{ id: q, text: `pergunta ${q} longa o bastante` }], source_ids: srcs, researched_source_ids: srcs, product_kinds: kinds });
writeFileSync(join(root, 'data/topics/colchao-d28.json'), JSON.stringify(topic('colchao-d28', ['espuma'], ['src_aaaaaaaaaaaa'], 'q_d28')));
writeFileSync(join(root, 'data/topics/travesseiro-x.json'), JSON.stringify(topic('travesseiro-x', ['travesseiro'], ['src_bbbbbbbbbbbb'], 'q_trav')));
writeFileSync(join(root, 'data/topics/como-escolher-colchao.json'), JSON.stringify(topic('como-escolher-colchao', ['molas_ensacadas'], [], 'q_novo')));
const claim = (id: string, src: string, q: string) => ({ id, source_id: src, quote: 'trecho literal verificado', claim_type: 'regulation', statement: `fato ${id}`, captured_at: '2026-10-20T12:00:00.000Z', question_ids: [q] });
writeFileSync(join(root, 'data/claims/clm_aaaaaaaaaaaa.json'), JSON.stringify(claim('clm_aaaaaaaaaaaa', 'src_aaaaaaaaaaaa', 'q_d28')));
writeFileSync(join(root, 'data/claims/clm_bbbbbbbbbbbb.json'), JSON.stringify(claim('clm_bbbbbbbbbbbb', 'src_bbbbbbbbbbbb', 'q_trav')));

describe('reuso de evidências', () => {
  it('só considera pautas da mesma categoria; liga à pergunta nova e marca a fonte como já pesquisada', async () => {
    let asked = '';
    const llm = async (_u: string, init: RequestInit) => {
      asked = JSON.parse(String(init.body)).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ links: [{ claim_id: 'clm_aaaaaaaaaaaa', question_ids: ['q_novo'] }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    };
    const { reuseEvidence } = await import('../src/stages/reuse.ts');
    const r = await reuseEvidence('como-escolher-colchao', llm);
    expect(asked).toContain('clm_aaaaaaaaaaaa');
    expect(asked).not.toContain('clm_bbbbbbbbbbbb'); // travesseiro é outra categoria
    expect(r).toEqual({ reused: 1, sources: 1 });
    const c = JSON.parse(readFileSync(join(root, 'data/claims/clm_aaaaaaaaaaaa.json'), 'utf8'));
    expect(c.question_ids).toEqual(['q_d28', 'q_novo']);
    expect(c.quote).toBe('trecho literal verificado');
    const t = JSON.parse(readFileSync(join(root, 'data/topics/como-escolher-colchao.json'), 'utf8'));
    expect(t.source_ids).toEqual(['src_aaaaaaaaaaaa']);
    expect(t.researched_source_ids).toEqual(['src_aaaaaaaaaaaa']);
  });
});
