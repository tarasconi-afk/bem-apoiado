import { describe, expect, it } from 'vitest';
import { asksForTitle } from '../src/stages/requests.ts';
import { makePatchSchema } from '../src/stages/patch.ts';

// 27/10: a auditoria do site achou 27 problemas em 25 páginas; 17 eram "secao_nao_entrega", cujo conserto é
// mudar o título da seção. Nenhum dos 14 cartões mudou um título, porque o caminho com blocos já escolhidos
// pulava o seletor. Sem alcançar o título, o redator apagava o bloco: três páginas perderam evidência boa.

describe('conserto de título da seção', () => {
  it('reconhece os consertos que a auditoria de coerência escreve', () => {
    for (const t of [
      'No bloco garantia#0: a seção promete prazos e exclusões. Conserto: Mudar o título da seção para "Garantia: posicionamento inadequado"',
      'O título promete explicar três tipos de protetor. Conserto: Mude o título para "Altura e compatibilidade"',
      'A seção anuncia se o apoio de cabeça muda o peso suportado.',
    ]) expect(asksForTitle(t)).toBe(true);
  });

  it('não liga o passo de título num pedido comum', () => {
    expect(asksForTitle('Reescreva a resposta curta para leigo, sem jargão.')).toBe(false);
    expect(asksForTitle('Tire a coluna de preço da tabela.')).toBe(false);
  });
});

describe('remendo sem remoção', () => {
  const schema = (allow: boolean) => makePatchSchema(['tipos#0'], ['clm_a'], new Map(), allow);

  it('com o título sendo corrigido, "remove" deixa de ser uma opção', () => {
    expect(schema(false).safeParse({ patches: [{ ref: 'tipos#0', action: 'remove' }] }).success).toBe(false);
    expect(schema(false).safeParse({ patches: [{ ref: 'tipos#0', action: 'replace', text: 'x', claim_ids: ['clm_a'] }] }).success).toBe(true);
  });

  it('fora desse caso, tirar o bloco continua valendo', () => {
    expect(schema(true).safeParse({ patches: [{ ref: 'tipos#0', action: 'remove' }] }).success).toBe(true);
  });
});
