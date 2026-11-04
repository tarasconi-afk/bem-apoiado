import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

// 29/10 a 04/11: látex, cobertor ou manta e cama box (pautas que já pararam por falta de evidência) voltavam a cada
// 3 dias NA FRENTE das pautas novas e gastaram ~170 créditos em 8 ciclos, sem nenhuma página. Pauta nova vai antes;
// a nova tentativa por lacuna só roda quando não há pauta nova. Retomada (pesquisa paga, sem lacuna) mantém a vez.
const raiz = mkdtempSync(join(tmpdir(), 'bem-retentativa-'));
mkdirSync(join(raiz, 'data', 'topics'), { recursive: true });
mkdirSync(join(raiz, 'data', 'pages'), { recursive: true });
writeFileSync(join(raiz, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
const topico = (slug: string, query: string, gaps: string[]) =>
  writeFileSync(join(raiz, 'data', 'topics', `${slug}.json`), JSON.stringify({
    slug, primary_query: query, page_type: 'decision_compare',
    questions: [{ id: 'q_a', text: 'O que o fabricante declara?' }],
    source_ids: ['src_aaaaaaaaaaaa'], researched_source_ids: ['src_aaaaaaaaaaaa'],
    evidence_gaps: gaps, editorial_notes: [], focus_terms: [], improve_attempts: 1, product_kinds: [], listing_terms: [],
  }));
const fila = (queries: string[]) =>
  writeFileSync(join(raiz, 'data', 'queue.json'), JSON.stringify({ items: queries.map((query) => ({ query, added_at: '2026-11-04' })) }));
topico('colchao-de-latex-vale-a-pena', 'colchão de látex vale a pena', ['Fonte de fabricante sobre para quem é indicado']);
topico('lencol-de-cetim-ou-percal-diferenca', 'lençol de cetim ou percal: diferença', []);
process.env.BEM_ROOT = raiz;
process.env.BEM_STATE_DIR = join(raiz, '.state');

const { nextQuery, queueStatus } = await import('../src/stages/autopilot.ts');
const estado = (re: RegExp) => queueStatus(new Set()).find((q) => re.test(q.query))!.state;

describe('pauta nova antes de nova tentativa por lacuna', () => {
  it('a pauta nova passa na frente da que já parou por falta de evidência', () => {
    fila(['colchão de látex vale a pena', 'como escolher lençol']);
    expect(nextQuery()).toBe('como escolher lençol');
    expect(estado(/lençol/)).toBe('próxima');
    expect(estado(/látex/)).toBe('na fila');
  });

  it('sem pauta nova, a nova tentativa ainda roda', () => {
    fila(['colchão de látex vale a pena']);
    expect(nextQuery()).toBe('colchão de látex vale a pena');
    expect(estado(/látex/)).toBe('próxima');
  });

  it('retomada de pesquisa paga, sem lacuna, mantém a vez na ordem da fila', () => {
    fila(['lençol de cetim ou percal: diferença', 'como escolher lençol']);
    expect(nextQuery()).toBe('lençol de cetim ou percal: diferença');
  });
});

describe('id de seção do rascunho', () => {
  it('fora do formato vira slug em vez de derrubar o rascunho', async () => {
    const { makeDraftSchema } = await import('../src/stages/draft-schema.ts');
    const S = makeDraftSchema(['clm_aaaaaaaaaaaa']).shape.sections.element.shape.id;
    expect(S.parse('Medidas do Lençol Solteirão')).toBe('medidas-do-lencol-solteirao');
    expect(S.parse('medidas')).toBe('medidas');
    expect(S.safeParse('---').success).toBe(false); // nada aproveitável continua recusado
    // e o schema enviado ao modelo continua descrevendo o formato certo
    expect(JSON.stringify(z.toJSONSchema(makeDraftSchema(['clm_aaaaaaaaaaaa']), { target: 'draft-7' }))).toContain('^[a-z0-9]+(?:-[a-z0-9]+)*$');
  });
});
