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

describe('auditoria do site', () => {
  it('pedido de ajuste só com blocos editáveis (linha de tabela fica de fora)', async () => {
    const { auditRequest } = await import('../src/stages/site-audit.ts');
    const r = auditRequest([f('produto_como_solucao', 'verdict', 'Generaliza.'), f('dado_de_produto_vira_regra', 'medidas#0.r1'), f('caso_sem_orientacao', 'verdict')]);
    expect(r.refs).toEqual(['verdict']);
    expect(r.text).toContain('No bloco verdict: Generaliza. Conserto: tirar o bloco');
    expect(r.text).not.toContain('medidas#0.r1');
  });
});
