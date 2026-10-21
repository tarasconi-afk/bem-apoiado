import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-lessons-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
mkdirSync(join(root, 'data'), { recursive: true });

const reply = (o: unknown) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));

describe('lições do editor', () => {
  it('pedido geral vira lição; específico ou repetido não; o redator recebe a lista', async () => {
    const { learnFromEditor, editorLessonsPrompt } = await import('../src/editor-lessons.ts');
    expect(await learnFromEditor('base-box', 'a medida do casal está errada', reply({ general: false, lesson: null, already_covered: false }))).toBeNull();
    expect(await learnFromEditor('base-box', 'pense como cliente', reply({ general: true, lesson: 'Comece a resposta curta pelo que o comprador precisa conferir.', already_covered: false }))).toMatch(/comprador/);
    expect(await learnFromEditor('cadeira', 'pense como cliente', reply({ general: true, lesson: 'Outra forma da mesma regra.', already_covered: true }))).toBeNull();
    expect(JSON.parse(readFileSync(join(root, 'data/editor-lessons.json'), 'utf8')).lessons).toHaveLength(1);
    expect(editorLessonsPrompt()).toContain('Comece a resposta curta');
  });
});
