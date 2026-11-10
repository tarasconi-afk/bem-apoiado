import { describe, expect, it } from 'vitest';
import { failedAdjust } from '../src/admin.ts';
import { respostaAbrePelaFonte } from '../src/stages/coherence.ts';

// 10/11/2026: painel levando ~1 min para abrir e resposta curta do edredom abrindo pela marca com nota 4 de 4.
describe('resposta curta que abre creditando a fonte (determinística)', () => {
  const v = (text: string) => ({ verdict: { text } }) as never;
  it('aponta os três casos reais do acervo', () => {
    for (const t of [
      'A Altenburg anuncia um edredom como uma peça única e um duvet com fechamento por zíper.',
      'A Döhler descreve um cobertor de 350 g/m² como oferecendo aquecimento sem perder leveza.',
      'Os fabricantes informam dimensões variadas: a Probel lista solteirão com 100 × 200 cm.',
      'Segundo a Probel, o colchão de molas ensacadas tem molas individuais.',
    ]) expect(respostaAbrePelaFonte(v(t))?.check, t).toBe('resposta_abre_pela_fonte');
  });
  it('não aponta resposta que decide primeiro e atribui depois', () => {
    for (const t of [
      'Escolha o duvet se quer trocar a capa sem lavar o enchimento; segundo a Trussardi, a capa sai pelo zíper.',
      'Para quem sente calor, o lençol de percal é a opção mais fresca, segundo a Buddemeyer.',
      'O colchão de molas ensacadas é indicado para casal com pesos diferentes, segundo a Probel.',
    ]) expect(respostaAbrePelaFonte(v(t)), t).toBeNull();
  });
});

describe('painel: git só quando há ajuste com falha', () => {
  it('sem ajuste com falha para a página, a data do último ajuste nem é consultada', () => {
    let chamadas = 0;
    const conta = () => { chamadas++; return 0; };
    expect(failedAdjust([], 'x', conta)).toBeNull();
    expect(failedAdjust([{ id: '1', label: '', args: ['ajustar', 'main', 'x'], started: '', ended: '2026-11-10T10:00:00Z', code: 0, output: 'ok' } as never], 'x', conta)).toBeNull();
    expect(chamadas).toBe(0);
    const falhou = [{ id: '2', label: '', args: ['ajustar', 'main', 'x'], started: '', ended: '2026-11-10T10:00:00Z', code: 1, output: 'NÃO salvo: motivo' } as never];
    expect(failedAdjust(falhou, 'x', conta)).toMatch(/NÃO salvo/);
    expect(chamadas).toBe(1);
    expect(failedAdjust(falhou, 'x', () => Date.parse('2026-11-10T11:00:00Z'))).toBeNull(); // ajuste salvo depois da falha
  });
});
