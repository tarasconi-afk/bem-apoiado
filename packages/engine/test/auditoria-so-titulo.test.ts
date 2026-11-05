import { describe, expect, it } from 'vitest';
import { titleOnlyRefs } from '../src/stages/requests.ts';

// Pedidos reais da auditoria semanal de 05/11 (cartões de solteirão/viúva, molas e cadeira com apoio de cabeça).
describe('conserto da auditoria que só pede título novo', () => {
  it('separa o bloco de título do bloco que precisa de reescrita', () => {
    const solteirao = 'No bloco base-compativel#0: A seção promete uma base ou estrado compatível com cada tamanho, mas o bloco só apresenta uma base para um kit de colchão viúva. Conserto: Mudar o título para algo como “Exemplo de base para o conjunto viúva citado”. No bloco peso-suportado#0: A seção promete o peso máximo suportado por tamanho, mas o bloco informa o limite de um modelo específico. Conserto: Mudar o título para algo como "Peso suportado nos modelos citados".';
    expect([...titleOnlyRefs(solteirao)].sort()).toEqual(['base-compativel#0', 'peso-suportado#0']);
    const cadeira = 'No bloco verdict: O leitor pode entender que o apoio compensa. Conserto: Reescrever para dizer apenas que o apoio encosta na cabeça. No bloco nr17-referencia#0: O título promete explicar a NR-17. Conserto: Mudar o título da seção para "Certificação citada".';
    expect([...titleOnlyRefs(cadeira)]).toEqual(['nr17-referencia#0']);
  });

  it('conserto que manda reescrever não é só título, mesmo citando o título', () => {
    const firme = 'No bloco como-decidir#1: O leitor que dorme de lado não sabe se escolhe macio ou firme. Conserto: Reescrever a orientação para deixar explícito apenas o que os trechos sustentam ou retirar da seção a promessa do título.';
    expect(titleOnlyRefs(firme).size).toBe(0);
  });
});
