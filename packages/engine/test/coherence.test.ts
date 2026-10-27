import { describe, expect, it } from 'vitest';
import { coherenceMajority, problemText, type CoherenceFinding } from '../src/stages/coherence.ts';
import { fourQuestions } from '../src/board.ts';

const f = (check: CoherenceFinding['check'], ref: string, problem = 'p'): CoherenceFinding => ({ check, ref, problem, fix: 'tirar o bloco' });

describe('auditoria de coerência', () => {
  it('fica só o que a maioria das 3 leituras apontou no mesmo bloco', () => {
    const out = coherenceMajority([
      [f('produto_como_solucao', 'dupla-face#0', 'primeira'), f('caso_sem_orientacao', 'verdict')],
      [f('produto_como_solucao', 'dupla-face#0', 'segunda')],
      [f('dado_de_produto_vira_regra', 'dupla-face#0')],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.problem).toBe('primeira');
  });
  it('o mesmo problema repetido numa leitura conta uma vez', () => {
    expect(coherenceMajority([[f('caso_sem_orientacao', 'verdict'), f('caso_sem_orientacao', 'verdict')], [], []])).toHaveLength(0);
  });
  it('texto do pedido diz o bloco e o que fazer', () => {
    expect(problemText(f('produto_como_solucao', 'x#1', 'O leitor entende errado.'))).toBe('O leitor entende errado (x#1); tirar o bloco');
  });
  it('o cartão diz o motivo quando o juiz aprovou e a coerência não', () => {
    expect(fourQuestions({ publishable: false, answers_primary_query: 'yes', coherence: [{ check: 'produto_como_solucao' }] })).toContain('coerência: produto apresentado como solução');
  });
});

describe('lista fechada de problemas (27/10)', () => {
  it('as 5 verificações têm rótulo para o cartão do editor', async () => {
    const { COHERENCE_CHECKS, CHECK_LABEL } = await import('../src/stages/coherence.ts');
    expect(COHERENCE_CHECKS).toContain('secao_nao_entrega');
    expect(COHERENCE_CHECKS).toContain('promessa_do_titulo');
    for (const c of COHERENCE_CHECKS) expect(CHECK_LABEL[c].length).toBeGreaterThan(10);
  });

  it('a maioria das 3 leituras também vale para as verificações novas', () => {
    const out = coherenceMajority([
      [f('secao_nao_entrega', 'tipos#0', 'O título promete 3 tipos e a seção só fala de altura.')],
      [f('secao_nao_entrega', 'tipos#0')],
      [f('promessa_do_titulo', 'verdict')],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.check).toBe('secao_nao_entrega');
  });
});

describe('auditoria do site', () => {
  it('pedido de ajuste só com blocos editáveis (linha de tabela fica de fora)', async () => {
    const { auditRequest } = await import('../src/stages/site-audit.ts');
    const r = auditRequest([f('produto_como_solucao', 'verdict', 'Generaliza.'), f('dado_de_produto_vira_regra', 'medidas#0.r1'), f('caso_sem_orientacao', 'verdict')]);
    expect(r.refs).toEqual(['verdict']);
    expect(r.text).toContain('No bloco verdict: Generaliza. Conserto: tirar o bloco');
    expect(r.text).not.toContain('medidas#0.r1');
  });
});

describe('conserto honesto não pode tirar a decisão', () => {
  it('conta os verbos de decisão da resposta curta', async () => {
    const { decisionMarkers } = await import('../src/stages/requests.ts');
    const antes = 'Se sua prioridade é conforto extra, escolha um pillow top. Se o espaço for limitado, escolha um colchão sem pillow top.';
    const depois = 'Pillow top é uma camada extra posicionada sobre o colchão. Confira a espessura do modelo.';
    expect(decisionMarkers(antes)).toBeGreaterThan(decisionMarkers(depois));
    // D28: ficou mais estreito e manteve o "Se você": passa
    expect(decisionMarkers('O D28 Guarda Costas suporta 90 kg. Se você dorme com alguém de peso diferente, confira a ficha.')).toBe(decisionMarkers('D28 suporta 90 kg. Se você dorme com alguém de peso diferente, confira a ficha.'));
  });
});
