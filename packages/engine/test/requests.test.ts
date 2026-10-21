import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-req-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
for (const d of ['topics', 'pages', 'claims', 'sources']) mkdirSync(join(root, 'data', d), { recursive: true });
writeFileSync(join(root, 'data/niche.json'), readFileSync(join(import.meta.dirname, '../../../data/niche.json')));
writeFileSync(join(root, 'data/queue.json'), JSON.stringify({ items: [{ query: 'colchão firme ou macio', added_at: '2026-10-20', origin: 'x' }] }));

describe('pedidos em texto livre', () => {
  it('transforma em ações seguras: fila, relatório e anotação para o desenvolvedor; não duplica pauta', async () => {
    const plan = { reply: 'Vou criar as pautas e anotar o pedido de visual.', actions: [
      { type: 'add_topics', queries: ['colchão para quem sente calor', 'colchão firme ou macio'] },
      { type: 'report', about: 'fila' },
      { type: 'developer', summary: 'mudar a cor do botão de compra' },
      { type: 'redo_page', slug: 'nao-existe', instruction: 'refazer com tabela' },
    ] };
    const llm = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const { handleRequest } = await import('../src/stages/requests.ts');
    const r = await handleRequest('crie pautas sobre calor e mude a cor do botão', 'run_x', llm);
    expect(r.done).toContain('fila: "colchão para quem sente calor"');
    expect(r.failed).toContain('"colchão firme ou macio" já estava na fila');
    expect(r.failed).toContain('página nao-existe não existe');
    expect(r.done.some((d) => d.startsWith('Fila com 2 pautas'))).toBe(true);
    const dev = JSON.parse(readFileSync(join(root, 'data/dev-requests.json'), 'utf8'));
    expect(dev[0]).toMatchObject({ summary: 'mudar a cor do botão de compra', status: 'aberto' });
  });
});
