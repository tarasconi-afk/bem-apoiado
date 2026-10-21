import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-apoiado-page-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'test-key';

const SENTENCES = Array.from({ length: 8 }, (_, i) => `Afirmação técnica número ${i + 1} sobre colchões de espuma e de molas.`);
const IDS = SENTENCES.map((_, i) => `clm_teste_${i}`);

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/niche.json'), JSON.stringify({
    brand: 'Site Teste', site_tagline: 't', site_intro: 'i', scope: 'compras de teste para o motor', audience: 'leitores',
    category_label: 'Teste', regulator_hints: ['Regulador X'], safety_rule: 'Segurança: nunca prometa efeito de saúde.',
    decision_outline: ['como funciona', 'Como decidir'], product_kinds: [{ id: 'outro', label: 'Outro' }],
  }));
  const src = join(root, 'data/sources/src_bbbbbbbbbbbb');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'text.txt'), SENTENCES.join('\n'));
  writeFileSync(join(src, 'raw.html'), 'x');
  writeFileSync(join(src, 'meta.json'), JSON.stringify({
    id: 'src_bbbbbbbbbbbb', url: 'https://r.test/a', final_url: 'https://r.test/a', fetched_at: '2026-10-20T12:00:00.000Z',
    http_status: 200, content_type: 'text/html', sha256: 'b'.repeat(64), raw_file: 'raw.html', text_file: 'text.txt',
    text_chars: 100, extractor_version: 2, title: 'Norma', publisher: 'Regulador', source_class: 'regulator',
  }));
  mkdirSync(join(root, 'data/claims'), { recursive: true });
  SENTENCES.forEach((q, i) =>
    writeFileSync(join(root, `data/claims/${IDS[i]}.json`), JSON.stringify({
      id: IDS[i], source_id: 'src_bbbbbbbbbbbb', quote: q, claim_type: 'regulation', statement: `Paráfrase ${i + 1} fiel.`,
      captured_at: '2026-10-20T12:00:00.000Z', question_ids: ['q_tipos'],
    })),
  );
  mkdirSync(join(root, 'data/topics'), { recursive: true });
  writeFileSync(join(root, 'data/topics/pagina-teste.json'), JSON.stringify({
    slug: 'pagina-teste', primary_query: 'colchão teste', page_type: 'decision_compare',
    questions: [{ id: 'q_tipos', text: 'Quais são os tipos de colchão e como funcionam?' }],
    source_ids: ['src_bbbbbbbbbbbb'],
  }));
});

const draft = (verdictText: string) => ({
  title: 'Colchão de molas ou espuma: qual escolher',
  description: 'Entenda a diferença entre colchão de molas e de espuma com base no que dizem as normas e os fabricantes.',
  verdict: { text: verdictText, basis: 'reasoning', claim_ids: [IDS[0]] },
  sections: ['tipos', 'etiqueta', 'como-decidir'].map((id, i) => ({
    id, heading: `Seção ${id}`,
    blocks: [
      { kind: 'paragraph', text: `Texto sustentado ${i}.`, basis: 'evidence', claim_ids: [IDS[i + 1]] },
      ...(id === 'tipos' ? [{ kind: 'paragraph', text: 'Outro texto sustentado.', basis: 'evidence', claim_ids: [IDS[5]] }] : []),
    ],
  })),
});

// Simula o roteador: responde conforme o modelo pedido no corpo da requisição.
function router(opts: { auditorRejectsAlways: boolean; publishable?: boolean; nearMiss?: boolean; rejectRef?: string }) {
  let writerCalls = 0;
  let reviews = 0;
  return async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    let content: unknown;
    if (body.model === 'claude-sonnet-5') {
      writerCalls++;
      // Rodadas de correção pedem remendos (page_patches), não a página inteira.
      content =
        body.response_format.json_schema.name === 'page_patches'
          ? opts.rejectRef
            ? { patches: [{ ref: opts.rejectRef, action: 'replace', text: 'Outro texto sustentado, reescrito.', basis: 'evidence', claim_ids: [IDS[5]] }] }
            : { patches: [{ ref: 'verdict', action: 'replace', text: 'Depende do uso, segundo as fontes citadas.', basis: 'reasoning', claim_ids: [IDS[0]] }] }
          : draft(opts.rejectRef ? 'Depende do uso, segundo as fontes citadas.' : 'Colchão de espuma sempre dura mais em qualquer caso.');
    } else if (body.response_format.json_schema.name === 'editorial_review') {
      reviews++;
      if (opts.nearMiss && reviews === 1) {
        // 1ª revisão: quase lá, com 1 bloco de enchimento apontado
        content = { answers_primary_query: 'partial', concrete_guidance: true, filler_refs: ['tipos#0', 'etiqueta#0'], decision_criteria: ['a', 'b'], missing: [], publishable: false, summary: 'quase' };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      const ok = opts.publishable ?? true;
      content = { answers_primary_query: ok ? 'yes' : 'partial', concrete_guidance: ok, filler_refs: [], decision_criteria: ok ? ['a', 'b'] : [], missing: ok ? [] : ['tabela do fabricante'], publishable: ok, summary: ok ? 'ok' : 'fina' };
    } else {
      const refs = [...String(body.messages[1].content).matchAll(/BLOCO (\S+)/g)].map((m) => m[1]);
      content = {
        findings: refs.map((ref) => ({
          ref,
          verdict: ref === opts.rejectRef ? 'UNSUPPORTED' : ref === 'verdict' && !opts.rejectRef && (opts.auditorRejectsAlways || writerCalls === 1) ? 'OVERSTATED' : 'SUPPORTED',
          problem: ref === 'verdict' ? '"sempre" generaliza' : '',
          fix: '',
        })),
      };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  };
}

describe('buildPage', () => {
  it('corrige o bloco exagerado e grava a página aprovada', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_a', router({ auditorRejectsAlways: false }));
    expect(r.status).toBe('PASS');
    expect(r.rounds).toBe(2);
    if (r.status === 'PASS') {
      expect(r.page.status).toBe('approved');
      expect(r.page.provenance.audit_verdict).toBe('pass');
    }
    expect(existsSync(join(root, 'data/pages/pagina-teste.json'))).toBe(true);
  });

  it('página correta mas inútil fica como rascunho (revisão editorial)', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_c', router({ auditorRejectsAlways: false, publishable: false }));
    expect(r.status).toBe('NOT_PUBLISHABLE');
    if (r.status === 'NOT_PUBLISHABLE') {
      expect(r.page.status).toBe('draft');
      expect(r.review.missing).toContain('tabela do fabricante');
    }
  });

  it('página quase aprovada: corta o enchimento apontado e passa na 2ª revisão', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_trim', router({ auditorRejectsAlways: false, nearMiss: true }));
    expect(r.status).toBe('PASS');
    // 2 de 5 blocos eram enchimento (40%): o corte roda e fica registrado. tipos#0 sai; etiqueta#0 fica,
    // porque era o único bloco da seção e o corte nunca esvazia seção.
    expect(existsSync(join(root, 'data/runs/run_trim/trim.json'))).toBe(true);
    if (r.status === 'PASS') {
      expect(r.page.sections.find((s) => s.id === 'tipos')!.blocks).toHaveLength(1);
      expect(r.page.sections.find((s) => s.id === 'etiqueta')!.blocks).toHaveLength(1);
    }
  });

  it('para em SAFE_STOP quando a auditoria não converge, sem gravar página', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_b', router({ auditorRejectsAlways: true }));
    expect(r.status).toBe('SAFE_STOP');
    if (r.status === 'SAFE_STOP') expect(r.open_issues.join(' ')).toContain('OVERSTATED');
  });

  it('não converge por um bloco só: remove o bloco e a página segue para a revisão', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_salvage', router({ auditorRejectsAlways: false, rejectRef: 'tipos#1' }));
    expect(r.status === 'SAFE_STOP' ? `${r.reason} ${r.open_issues.join(' | ')}` : r.status).toBe('PASS');
    if (r.status === 'PASS') {
      const tipos = r.page.sections.find((x) => x.id === 'tipos')!;
      expect(tipos.blocks).toHaveLength(1);
      expect(JSON.stringify(r.page)).not.toContain('Outro texto sustentado');
      expect(r.page.verdict.text).toBe('Depende do uso, segundo as fontes citadas.');
    }
  });
});
