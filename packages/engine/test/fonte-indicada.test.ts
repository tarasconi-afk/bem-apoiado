import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 28/10: quando a busca falhava três semanas, o motor escrevia "só um fabricante ou fonte indicada por você
// resolve" — e não havia como indicar. O painel só aprovava ou bloqueava domínio. A saída prometida não existia.
// O que este teste trava: a indicação NÃO pode virar um atalho para furar o cadastro de domínios.
const raiz = mkdtempSync(join(tmpdir(), 'bem-fonte-'));
mkdirSync(join(raiz, 'data', 'registry'), { recursive: true });
mkdirSync(join(raiz, 'data', 'topics'), { recursive: true });
writeFileSync(join(raiz, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
writeFileSync(join(raiz, 'data', 'registry', 'domains.json'), JSON.stringify({
  // Espelha o cadastro real: gov.br só vale no caminho do órgão (/inmetro), não o portal inteiro.
  allow: [{ host: 'gov.br', path: '/inmetro', publisher: 'Inmetro', source_class: 'regulator' }],
  block: ['loja-qualquer.com.br'],
}));
writeFileSync(join(raiz, 'data', 'topics', 'edredom-ou-cobertor-diferenca.json'), JSON.stringify({
  slug: 'edredom-ou-cobertor-diferenca',
  primary_query: 'edredom ou cobertor: diferença',
  page_type: 'decision_compare',
  questions: [{ id: 'q_etiqueta', text: 'O que a etiqueta têxtil exige informar sobre conservação?' }],
  source_ids: [], editorial_notes: [], focus_terms: [], evidence_gaps: [], researched_source_ids: [],
  improve_attempts: 0, product_kinds: [], listing_terms: [],
}));
process.env.BEM_ROOT = raiz;
process.env.BEM_STATE_DIR = join(raiz, '.state');

const { addIndicatedSource } = await import('../src/stages/indicated-source.ts');
const SLUG = 'edredom-ou-cobertor-diferenca';

describe('fonte indicada pelo editor', () => {
  it('domínio fora do cadastro não entra, e a mensagem diz onde aprovar', async () => {
    const r = await addIndicatedSource(SLUG, 'https://blog-de-decoracao.com.br/edredom', 'run_teste');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/não está no cadastro/i);
    expect(r.message).toMatch(/Domínios/i); // para onde mandar o editor
  });

  it('domínio bloqueado continua bloqueado', async () => {
    const r = await addIndicatedSource(SLUG, 'https://loja-qualquer.com.br/produto', 'run_teste');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/bloqueado/i);
  });

  it('endereço mal colado não vira tentativa de leitura', async () => {
    for (const ruim of ['gov.br/inmetro', 'javascript:alert(1)', 'nada disso']) {
      const r = await addIndicatedSource(SLUG, ruim, 'run_teste');
      expect(r.ok, ruim).toBe(false);
      expect(r.message).toMatch(/endereço inválido/i);
    }
  });

  it('pauta que não existe é recusada antes de qualquer gasto', async () => {
    const r = await addIndicatedSource('pauta-que-nao-existe', 'https://www.gov.br/inmetro/x', 'run_teste');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/não existe pauta/i);
  });
});
