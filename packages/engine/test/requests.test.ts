import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-req-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
for (const d of ['topics', 'pages', 'claims', 'sources']) mkdirSync(join(root, 'data', d), { recursive: true });
// Nicho real sem os tipos criados pelo Pedir ao motor (o teste de tipo novo cria o protetor de novo; 23/10 o teste
// quebrou o aceite do próprio tipo, porque o nicho real já o tinha).
const niche = JSON.parse(readFileSync(join(import.meta.dirname, '../../../data/niche.json'), 'utf8'));
const created = new Set(['protetor', 'pillow_top']);
niche.product_kinds = niche.product_kinds.filter((k: { id: string }) => !created.has(k.id));
for (const c of niche.categories) c.kinds = c.kinds.filter((k: string) => !created.has(k));
writeFileSync(join(root, 'data/niche.json'), JSON.stringify(niche));
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

describe('tema pelo pedido', () => {
  it('muda só o pedido, valida faixa e recusa valor fora do permitido', async () => {
    const run = async (changes: unknown) => {
      const plan = { reply: 'ok', actions: [{ type: 'theme', changes }] };
      const llm = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      const { handleRequest } = await import('../src/stages/requests.ts');
      return handleRequest('botão de compra contorno e texto "Ver na Amazon"', 'run_t', llm);
    };
    const ok = await run({ cta: { style: 'contorno', label: 'Ver na Amazon' } });
    expect(ok.done[0]).toMatch(/^tema alterado/);
    const t = JSON.parse(readFileSync(join(process.env.BEM_ROOT!, 'data/theme.json'), 'utf8'));
    expect(t.cta).toEqual({ label: 'Ver na Amazon', style: 'contorno' });
    expect(t.colors.brand).toBe('#1e5b4c');
    const bad = await run({ text_scale: 3, colors: { brand: 'vermelho' } });
    expect(bad.failed[0]).toMatch(/fora do permitido.*(text_scale|colors\.brand)/);
    expect(JSON.parse(readFileSync(join(process.env.BEM_ROOT!, 'data/theme.json'), 'utf8')).text_scale).toBe(1);
  });
});

describe('tipo de produto novo pelo pedido', () => {
  it('cria acessório no nicho, na categoria, na pauta e nos fabricantes já cadastrados; recusa duplicado', async () => {
    mkdirSync(join(root, 'data/registry'), { recursive: true });
    writeFileSync(join(root, 'data/registry/domains.json'), JSON.stringify({ _comment: 'x', allow: [{ host: 'fibrasca.com.br', publisher: 'Fibrasca', source_class: 'manufacturer', kinds: ['travesseiro'] }], block: [] }));
    writeFileSync(join(root, 'data/topics/protetor-de-colchao-vale-a-pena.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(import.meta.dirname, '../../../data/topics/protetor-de-colchao-vale-a-pena.json'), 'utf8')), product_kinds: ['outro'] }));
    const { createKind } = await import('../src/stages/requests.ts');
    const msg = createKind({ label: 'Protetor de colchão', accessory: true, category: 'colchao', slugs: ['protetor-de-colchao-vale-a-pena'], makers: ['Fibrasca', 'Marca Inventada'] });
    expect(msg).toContain('tipo novo "Protetor de colchão" (protetor, acessório');
    expect(msg).toContain('fora do cadastro (não marcados): Marca Inventada');
    const niche = JSON.parse(readFileSync(join(root, 'data/niche.json'), 'utf8'));
    expect(niche.product_kinds.at(-1).id).toBe('outro');
    expect(niche.product_kinds.find((k: { id: string }) => k.id === 'protetor')).toEqual({ id: 'protetor', label: 'Protetor de colchão', accessory: true });
    expect(niche.product_kinds.find((k: { id: string }) => k.id === 'espuma').accessory).toBeUndefined();
    expect(niche.categories.find((c: { id: string }) => c.id === 'colchao').kinds).toContain('protetor');
    expect(JSON.parse(readFileSync(join(root, 'data/topics/protetor-de-colchao-vale-a-pena.json'), 'utf8')).product_kinds).toEqual(['protetor']);
    const reg = JSON.parse(readFileSync(join(root, 'data/registry/domains.json'), 'utf8'));
    expect(reg._comment).toBe('x');
    expect(reg.allow[0].kinds).toEqual(['travesseiro', 'protetor']);
    const { loadNiche } = await import('../src/niche.ts');
    expect(loadNiche().product_kinds.some((k) => k.id === 'protetor' && k.accessory)).toBe(true);
    expect(() => createKind({ label: 'protetor de colchao', accessory: true, category: '', slugs: [], makers: [] })).toThrow(/já existe/);
  });
});

describe('ajuste sem ganho vira lacuna da pauta', () => {
  it('guarda o que falta de conteúdo (não de forma) e não duplica', async () => {
    const { recordGaps } = await import('../src/stages/requests.ts');
    const slug = 'protetor-de-colchao-vale-a-pena';
    const missing = ['Resposta curta que resolva sozinha a dúvida simples, em até 3 frases e sem jargão', 'Para o leitor leigo: A página usa termos técnicos', 'Uma regra direta para escolher entre os tipos conforme o uso'];
    expect(recordGaps(slug, missing)).toContain('falta fonte, não texto');
    recordGaps(slug, missing);
    const gaps = JSON.parse(readFileSync(join(root, `data/topics/${slug}.json`), 'utf8')).evidence_gaps as string[];
    expect(gaps.filter((g) => g === 'Uma regra direta para escolher entre os tipos conforme o uso')).toHaveLength(1);
    expect(gaps.some((g) => /leigo|3 frases/.test(g))).toBe(false);
    expect(recordGaps(slug, ['Para o leitor leigo: jargão'])).toBe('');
    expect(JSON.parse(readFileSync(join(root, 'data/source-gaps.json'), 'utf8'))[slug]).toMatchObject({ tries: 0, gaps: ['Uma regra direta para escolher entre os tipos conforme o uso'] });
  });
});
