import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Repositório descartável: o estágio lê e grava em data/, então o teste nunca toca o data/ real.
const root = mkdtempSync(join(tmpdir(), 'bem-apoiado-test-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'test-key';

const SOURCE_TEXT = 'Colchões de molas ensacadas têm cada mola dentro de um saco de tecido próprio.\nA densidade indica quantos quilos de espuma há em um metro cúbico.';

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  const src = join(root, 'data/sources/src_aaaaaaaaaaaa');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'text.txt'), SOURCE_TEXT);
  writeFileSync(join(src, 'raw.html'), '<p>x</p>');
  writeFileSync(
    join(src, 'meta.json'),
    JSON.stringify({
      id: 'src_aaaaaaaaaaaa', url: 'https://f.test/a', final_url: 'https://f.test/a', fetched_at: '2026-10-20T12:00:00.000Z',
      http_status: 200, content_type: 'text/html', sha256: 'a'.repeat(64), raw_file: 'raw.html', text_file: 'text.txt',
      text_chars: SOURCE_TEXT.length, extractor_version: 2, title: 'Guia', publisher: 'Fabricante', source_class: 'manufacturer',
    }),
  );
  mkdirSync(join(root, 'data/topics'), { recursive: true });
  writeFileSync(
    join(root, 'data/topics/teste.json'),
    JSON.stringify({
      slug: 'teste', primary_query: 'teste', page_type: 'explainer',
      questions: [{ id: 'q_tipos', text: 'Como é construído o colchão de molas ensacadas?' }],
      source_ids: ['src_aaaaaaaaaaaa'],
    }),
  );
});

const reply = (candidates: unknown[]) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));

describe('research', () => {
  it('aceita trecho literal e rejeita trecho inventado', async () => {
    const { research } = await import('../src/stages/research.ts');
    const r = await research('teste', 'run_test', reply([
      { question_id: 'q_tipos', quote: 'Colchões de molas ensacadas têm cada mola dentro de um saco de tecido próprio.', claim_type: 'definition', statement: 'Segundo o fabricante, cada mola fica em um saco próprio.' },
      { question_id: 'q_tipos', quote: 'Molas ensacadas duram vinte anos sem perder firmeza.', claim_type: 'spec', statement: 'Duram vinte anos.' },
    ]));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(['QUOTE_NOT_IN_SOURCE']);
    expect(r.coverage.q_tipos).toBe(1);
    expect(readdirSync(join(root, 'data/claims'))).toHaveLength(1);
  });

  it('pergunta fora da pauta não passa no schema (enum fechado)', async () => {
    const { research } = await import('../src/stages/research.ts');
    const r = await research('teste', 'run_test2', reply([
      { question_id: 'q_inexistente', quote: 'A densidade indica quantos quilos de espuma há em um metro cúbico.', claim_type: 'definition', statement: 'Densidade é kg/m³.' },
    ]));
    expect(r.accepted).toHaveLength(0);
    expect(r.errors[0]?.error).toContain('saída inválida');
  });
});
