import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 29/10, toalha de banho: o ciclo gastou 61,6 créditos, pesquisou 64 evidências, respondeu todas as perguntas da
// pauta e parou no teto de créditos ANTES de escrever a página. A fila então a tratou como "esgotada" — pesquisada
// e sem lacuna — e nunca mais voltaria a ela. A pesquisa paga virava lixo em silêncio.
// Sem página escrita, "sem lacuna" não é fim de caminho: é trabalho interrompido.
const raiz = mkdtempSync(join(tmpdir(), 'bem-retomada-'));
mkdirSync(join(raiz, 'data', 'topics'), { recursive: true });
mkdirSync(join(raiz, 'data', 'pages'), { recursive: true });
writeFileSync(join(raiz, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
writeFileSync(join(raiz, 'data', 'queue.json'), JSON.stringify({ items: [{ query: 'como escolher toalha de banho', added_at: '2026-10-28' }] }));
writeFileSync(join(raiz, 'data', 'topics', 'como-escolher-toalha-de-banho.json'), JSON.stringify({
  slug: 'como-escolher-toalha-de-banho',
  primary_query: 'como escolher toalha de banho',
  page_type: 'buying_guide',
  questions: [{ id: 'q_gramatura', text: 'Qual gramatura o fabricante declara?' }],
  source_ids: ['src_aaaaaaaaaaaa', 'src_bbbbbbbbbbbb'],
  researched_source_ids: ['src_aaaaaaaaaaaa', 'src_bbbbbbbbbbbb'], // pesquisa paga
  evidence_gaps: [], // nada em aberto: todas as perguntas foram respondidas
  editorial_notes: [], focus_terms: [], improve_attempts: 0, product_kinds: ['toalha'], listing_terms: [],
}));
process.env.BEM_ROOT = raiz;
process.env.BEM_STATE_DIR = join(raiz, '.state');

const { nextQuery, queueStatus } = await import('../src/stages/autopilot.ts');
const PAGINA = join(raiz, 'data', 'pages', 'como-escolher-toalha-de-banho.json');

describe('pauta pesquisada que parou antes da redação', () => {
  it('volta para a fila enquanto não houver página escrita', () => {
    expect(nextQuery()).toBe('como escolher toalha de banho');
    expect(queueStatus(new Set()).find((q) => /toalha/.test(q.query))!.state).toBe('próxima');
  });

  it('para de voltar assim que a página existe, mesmo como rascunho', () => {
    // Rascunho é fim do caminho do motor: a decisão passa a ser do editor, no quadro.
    copyFileSync(join(process.cwd(), 'data', 'pages', 'travesseiro-alto-ou-baixo.json'), PAGINA);
    const spec = JSON.parse(readFileSync(PAGINA, 'utf8'));
    writeFileSync(PAGINA, JSON.stringify({ ...spec, slug: 'como-escolher-toalha-de-banho', status: 'draft' }));
    expect(nextQuery()).toBe(null);
    expect(queueStatus(new Set()).find((q) => /toalha/.test(q.query))!.state).toBe('rascunho');
    rmSync(PAGINA);
  });
});
