// Lados da decisão (13/11): "pillow top ou topper" foi à redação com 32 evidências e nenhuma dizia "topper".
import { describe, expect, it } from 'vitest';
import { ladosDaPergunta, ladosSemEvidencia } from '../src/stages/lados.ts';

describe('lados da decisão', () => {
  it('extrai os lados antes dos dois-pontos', () => {
    expect(ladosDaPergunta('pillow top ou topper: diferença')).toEqual(['pillow top', 'topper']);
    expect(ladosDaPergunta('como escolher edredom')).toEqual([]);
  });
  it('barra o lado sem evidência (caso real do ciclo de 13/11)', () => {
    const trechos = ['O Pillow Top HR Gel tem lâmina de espuma de 5 cm.', 'Pillow-top de microfibra: lavar à mão ou à máquina.'];
    expect(ladosSemEvidencia('pillow top ou topper', trechos)).toEqual(['topper']);
  });
  it('aceita forma flexionada e plural (viscoelástico × viscoelástica, toppers)', () => {
    expect(ladosSemEvidencia('travesseiro de látex ou viscoelástico', ['espuma viscoelástica de alta densidade', 'látex natural'])).toEqual([]);
    expect(ladosSemEvidencia('pillow top ou topper', ['pillow top costurado', 'toppers avulsos com elástico'])).toEqual([]);
  });
  it('pergunta sem comparação passa', () => {
    expect(ladosSemEvidencia('quando trocar a toalha de banho', [])).toEqual([]);
  });
});
