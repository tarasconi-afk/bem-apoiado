import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
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
      // O "Como decidir" fala das duas opções do título (regra de decisão de 23/10).
      { kind: 'paragraph', text: id === 'como-decidir' ? `Texto sustentado ${i} sobre molas e espuma.` : `Texto sustentado ${i}.`, basis: 'evidence', claim_ids: [IDS[i + 1]] },
      ...(id === 'tipos' ? [{ kind: 'paragraph', text: 'Outro texto sustentado.', basis: 'evidence', claim_ids: [IDS[5]] }] : []),
    ],
  })),
});

// Simula o roteador: responde conforme o modelo pedido no corpo da requisição.
function router(opts: { coherence?: boolean; coherenceOnce?: boolean; auditorRejectsAlways: boolean; supportAll?: boolean; verdictText?: string; publishable?: boolean; nearMiss?: boolean; rejectRef?: string; rejectWhileWriter?: string }) {
  let writerCalls = 0;
  let lastWriter = '';
  let reviews = 0;
  let coherenceCalls = 0;
  return async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    let content: unknown;
    if (body.model === 'claude-haiku-4.5' || body.model === 'claude-sonnet-5') {
      writerCalls++;
      lastWriter = body.model;
      // Rodadas de correção pedem remendos (page_patches), não a página inteira.
      content =
        body.response_format.json_schema.name === 'page_patches'
          ? opts.rejectRef
            ? { patches: [{ ref: opts.rejectRef, action: 'replace', text: 'Outro texto sustentado, reescrito.', basis: 'evidence', claim_ids: [IDS[5]] }] }
            : { patches: [{ ref: 'verdict', action: 'replace', text: 'Depende do uso, segundo as fontes citadas.', basis: 'reasoning', claim_ids: [IDS[0]] }] }
          : draft(opts.verdictText ?? (opts.rejectRef ? 'Depende do uso, segundo as fontes citadas.' : 'Colchão de espuma sempre dura mais em qualquer caso.'));
    } else if (body.response_format.json_schema.name === 'coherence') {
      coherenceCalls++;
      // Cada auditoria de coerência são 3 leituras: "once" = só a primeira auditoria aponta problema.
      const fire = opts.coherenceOnce ? coherenceCalls <= 3 : !!opts.coherence;
      content = { findings: fire ? [{ check: 'produto_como_solucao', ref: 'verdict', problem: 'O leitor entende que a espuma resolve o caso dele.', fix: 'Dizer só o que a fonte descreve.' }] : [] };
    } else if (body.response_format.json_schema.name === 'editorial_review') {
      reviews++;
      if (opts.nearMiss && reviews <= 3) { // 1ª revisão = 3 avaliações (maioria)
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
          verdict: opts.supportAll ? 'SUPPORTED' : opts.rejectWhileWriter && lastWriter === opts.rejectWhileWriter ? 'UNSUPPORTED' : ref === opts.rejectRef ? 'UNSUPPORTED' : ref === 'verdict' && !opts.rejectRef && (opts.auditorRejectsAlways || writerCalls === 1) ? 'OVERSTATED' : 'SUPPORTED',
          problem: ref === 'verdict' ? '"sempre" generaliza' : '',
          fix: '',
        })),
      };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  };
}

describe('buildPage', () => {
  it('coerência: juiz aprova, mas produto como solução reprova e vira pedido de correção', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_coh', router({ auditorRejectsAlways: false, coherence: true }));
    expect(r.status).toBe('NOT_PUBLISHABLE');
    if (r.status !== 'NOT_PUBLISHABLE') return;
    expect(r.page.status).toBe('draft');
    expect(r.review.coherence?.[0]?.check).toBe('produto_como_solucao');
    const { correctionText } = await import('../src/board.ts');
    expect(correctionText(r.review)).toContain('a espuma resolve o caso dele');
  });

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
    // Limite calibrado em 25%: com o padrão (50%) a página de 40% já passaria de primeira, sem corte.
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/calibration.json'), JSON.stringify({ max_filler_ratio: 0.25, min_criteria: 2 }));
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
    unlinkSync(join(root, 'data/calibration.json'));
  });

  it('para em SAFE_STOP quando a auditoria não converge, sem gravar página', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_b', router({ auditorRejectsAlways: true }));
    expect(r.status).toBe('SAFE_STOP');
    if (r.status === 'SAFE_STOP') expect(r.open_issues.join(' ')).toContain('OVERSTATED');
  });

  it('redator barato não converge: segunda tentativa com o Sonnet passa', async () => {
    process.env.BEM_ESCALATION = '1'; // desligada por padrão desde 21/10
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_escala', router({ auditorRejectsAlways: false, rejectWhileWriter: 'claude-haiku-4.5', rejectRef: 'nenhum' }));
    expect(r.status).toBe('PASS');
    if (r.status === 'PASS') expect(r.page.provenance.writer_model).toBe('claude-sonnet-5');
    expect(process.env.BEM_MODEL_WRITER).toBeUndefined();
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

describe('aprovação de primeira (27/10)', () => {
  it('resposta curta que abre com "Segundo a X" não perde a rodada: a forma é consertada antes do gate', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_forma', router({ auditorRejectsAlways: false, supportAll: true, verdictText: 'Segundo a Castor, escolha D33 pelo peso.' }));
    expect(r.status).toBe('PASS');
    expect(r.rounds).toBe(1);
    if (r.status === 'PASS') expect(r.page.verdict.text).toBe('Escolha D33 pelo peso, segundo a Castor.');
  });

  it('coerência apontada antes da revisão: o redator remenda, o auditor confere e a página passa', async () => {
    const { buildPage } = await import('../src/stages/page.ts');
    const r = await buildPage('pagina-teste', 'run_coh_fix', router({ auditorRejectsAlways: false, coherenceOnce: true }));
    expect(r.status).toBe('PASS');
    expect(existsSync(join(root, 'data/runs/run_coh_fix/coherence-fix-1.json'))).toBe(true);
    expect(existsSync(join(root, 'data/runs/run_coh_fix/coherence-1.json'))).toBe(true);
    if (r.status === 'PASS') expect(r.page.verdict.text).toBe('Depende do uso, segundo as fontes citadas.');
  });

  it('coluna de tabela sem dado sai sem IA; a tabela que sobra passa no gate', async () => {
    const { fixFormWithoutAI, styleIssues } = await import('../src/stages/page.ts');
    const cell = (text: string) => ({ text, claim_ids: ['clm_x'] });
    const d = {
      title: 't', description: 'd'.repeat(60), verdict: { text: 'Escolha pela medida.', basis: 'evidence', claim_ids: ['clm_x'] },
      sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'table', caption: 'Medidas', columns: ['Tamanho', 'Medida', 'Para quem serve'], rows: [
        { cells: [cell('Solteiro'), cell('88 × 188 cm'), cell('não informada nas fontes')] },
        { cells: [cell('Solteirão'), cell('100 × 200 cm'), cell('não informada nas fontes')] },
        { cells: [cell('Viúva'), cell('128 × 188 cm'), cell('Casal com biotipos diferentes')] },
      ] }] }],
    };
    const r = fixFormWithoutAI(d as never);
    const t = r.draft.sections[0]!.blocks[0] as { columns: string[]; rows: unknown[] };
    expect(t.columns).toEqual(['Tamanho', 'Medida']);
    expect(t.rows).toHaveLength(3);
    expect(r.refs).toContain('como-decidir#0');
    expect(styleIssues(r.draft).filter((x) => /célula|repete/.test(x.msg))).toEqual([]);
  });

  it('bloco de transição que só anuncia o próximo assunto sai sem IA', async () => {
    const { fixFormWithoutAI, ANNOUNCE } = await import('../src/stages/page.ts');
    expect(ANNOUNCE.test('A seguir, veja o que os fabricantes citados dizem sobre durabilidade.')).toBe(true);
    expect(ANNOUNCE.test('Veja a seguir como peso e altura aparecem nas fontes consultadas.')).toBe(true);
    expect(ANNOUNCE.test('Compare as informações disponíveis sobre protetores com elástico.')).toBe(true);
    // Frase que diz algo ao leitor fica, mesmo começando por verbo.
    expect(ANNOUNCE.test('Confira na ficha a densidade indicada para o seu peso antes de comprar.')).toBe(false);
    expect(ANNOUNCE.test('Se você divide a cama, prefira molas ensacadas.')).toBe(false);
    const d = {
      title: 't', description: 'd'.repeat(60), verdict: { text: 'Escolha pelo peso.', basis: 'evidence', claim_ids: ['clm_x'] },
      sections: [{ id: 'tipos', heading: 'Tipos', blocks: [
        { kind: 'paragraph', text: 'A seguir, veja o que os fabricantes citados dizem sobre durabilidade.', basis: 'framing', claim_ids: [] },
        { kind: 'paragraph', text: 'A Castor informa densidade D33 para 71 a 80 kg.', basis: 'evidence', claim_ids: ['clm_x'] },
      ] }],
    };
    const r = fixFormWithoutAI(d as never);
    expect(r.draft.sections[0]!.blocks).toHaveLength(1);
    expect(JSON.stringify(r.draft)).not.toContain('A seguir');
  });

  it('versão sustentável do auditor e resposta curta ganham a forma do site sem IA', async () => {
    const { verdictFormOf } = await import('../src/stages/page.ts');
    expect(verdictFormOf('Segundo a Castor, escolha D33 pelo peso. Confira a ficha.')).toBe('Escolha D33 pelo peso, segundo a Castor. Confira a ficha.');
    expect(verdictFormOf('De acordo com fabricantes, molas ensacadas reduzem o movimento.')).toBe('Molas ensacadas reduzem o movimento, de acordo com fabricantes.');
    expect(verdictFormOf('Escolha pelo peso, segundo a Castor.')).toBe('Escolha pelo peso, segundo a Castor.');
  });

  it('cada evidência diz ao redator o seu alcance', async () => {
    const { claimScope, formatClaims } = await import('../src/stages/write.ts');
    expect(claimScope({ claim_type: 'spec' }, { source_class: 'manufacturer' })).toContain('SÓ O PRODUTO');
    expect(claimScope({ claim_type: 'availability' }, { source_class: 'manufacturer' })).toContain('SÓ O PRODUTO');
    expect(claimScope({ claim_type: 'definition' }, { source_class: 'manufacturer' })).toContain('posição da marca');
    expect(claimScope({ claim_type: 'regulation' }, { source_class: 'regulator' })).toContain('regra geral');
    expect(claimScope({ claim_type: 'spec' }, { source_class: 'standard_body' })).toContain('regra geral');
    const c = { id: 'clm_a', source_id: 'src_x', quote: 'Mede 100 × 200 cm.', claim_type: 'spec', statement: 'Mede 100 × 200.', captured_at: '2026-10-20T12:00:00.000Z', question_ids: [] } as never;
    const s = new Map([['src_x', { id: 'src_x', publisher: 'Probel', source_class: 'manufacturer', final_url: 'https://probel.test/x', title: 'Prohotel Royal' } as never]]);
    expect(formatClaims([c], s)).toContain('alcance: SÓ O PRODUTO');
  });
});

describe('célula de tabela sem dado', () => {
  it('cobra célula que só manda conferir; aceita a que traz número', async () => {
    const { styleIssues } = await import('../src/stages/page.ts');
    const cell = (text: string) => ({ text, claim_ids: ['clm_x'] });
    const d = {
      title: 't', description: 'd'.repeat(60), verdict: { text: 'Escolha pelo peso.', basis: 'evidence', claim_ids: ['clm_x'] },
      sections: [{ id: 'como-decidir', heading: 'Como decidir', blocks: [{ kind: 'table', caption: 'Fichas', columns: ['Item', 'A', 'B'], rows: [
        { cells: [cell('Peso'), cell('120 kg'), cell('Confira no Diretor')] },
        { cells: [cell('Garantia'), cell('3 anos'), cell('5 anos')] },
      ] }] }],
    };
    const refs = styleIssues(d as never).filter((x) => x.msg.startsWith('célula')).map((x) => x.ref);
    expect(refs).toEqual(['como-decidir#0.r0']);
  });
});

describe('resposta curta não abre com atribuição', () => {
  it('pega marca e atribuição genérica', async () => {
    const { styleIssues } = await import('../src/stages/page.ts');
    const d = (text: string) => ({ title: 't', description: 'd'.repeat(60), verdict: { text, basis: 'evidence', claim_ids: ['c'] }, sections: [] });
    const hit = (text: string) => styleIssues(d(text) as never).some((i) => i.ref === 'verdict' && i.msg.includes('abrir citando'));
    expect(hit('Segundo fabricantes citados, molas ensacadas reduzem a transferência.')).toBe(true);
    expect(hit('Segundo a Castor, escolha D33.')).toBe(true);
    expect(hit('Se você divide a cama, escolha molas ensacadas, segundo a Probel.')).toBe(false);
  });
});
