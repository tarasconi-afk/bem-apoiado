import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-plan-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'test';

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/niche.json'), JSON.stringify({
    brand: 'Site Teste', site_tagline: 't', site_intro: 'i', scope: 'compras de brinquedos para crianças', audience: 'pais e mães',
    category_label: 'Brinquedos', regulator_hints: ['Inmetro'], safety_rule: 'Segurança: nunca afirmar idade fora da indicada.',
    decision_outline: ['tipos', 'Como decidir'], product_kinds: [{ id: 'montar', label: 'Blocos de montar' }],
  }));
});

const reply = (content: unknown) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));

describe('planTopic', () => {
  it('cria a pauta com slug derivado da dúvida e tipos do vocabulário do nicho', async () => {
    const { planTopic } = await import('../src/stages/plan.ts');
    const { topic, created } = await planTopic('Blocos de montar: qual idade?', reply({
      page_type: 'buying_guide',
      questions: [1, 2, 3, 4].map((i) => ({ id: `q_p${i}`, text: `Pergunta de teste número ${i} sobre blocos` })),
      focus_terms: ['blocos', 'idade'], product_kinds: ['montar'], editorial_notes: [],
    }));
    expect(created).toBe(true);
    expect(topic.slug).toBe('blocos-de-montar-qual-idade');
    expect(existsSync(join(root, 'data/topics/blocos-de-montar-qual-idade.json'))).toBe(true);
  });

  it('tipo de produto fora do vocabulário do nicho é rejeitado', async () => {
    const { planTopic } = await import('../src/stages/plan.ts');
    await expect(planTopic('Outra dúvida de teste', reply({
      page_type: 'explainer', questions: [1, 2, 3, 4].map((i) => ({ id: `q_o${i}`, text: `Outra pergunta de teste ${i} aqui` })),
      focus_terms: ['a1', 'b2'], product_kinds: ['colchao'], editorial_notes: [],
    }))).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});
