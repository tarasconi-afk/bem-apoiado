import { describe, expect, it } from 'vitest';
import { CARD_OWN_BOX } from '../src/admin.ts';

// 29/10, o editor: "não recusei nenhuma manualmente, todas as mudanças que tive hoje eu aceitei". Mas o motor
// registrou "recusado: Ordem dos guias na home" em todo ciclo desde 28/10, e o arquivo data/home-order.json era
// apagado do main toda vez. Causa: o cartão separa os itens em "tem caixa própria" (visual) e "vai escondido";
// "home" e "theme" estavam no primeiro grupo e NENHUMA das três partes do cartão os desenhava. Sumiam do
// formulário, e o que não vem no formulário é recusa.
describe('nenhum item pode sumir do formulário do cartão', () => {
  // Todos os ids que changes.ts sabe produzir. Ao criar um tipo novo lá, ele entra aqui — e aí este teste
  // obriga a decidir: ganha caixa no cartão (CARD_OWN_BOX) ou viaja escondido.
  const IDS = ['images', 'product:B01ABCDEFG', 'theme', 'home', 'anchors', 'search-links', 'niche', 'page:colchao-d28-ou-d33', 'other:data/x.json'];

  // As três partes do cartão que desenham caixa: imagens, produtos e o bloco "Também entra" (home e tema).
  const DESENHADOS = (id: string) => id === 'images' || id.startsWith('product:') || id === 'home' || id === 'theme';

  it('todo item com caixa própria é desenhado por alguma parte do cartão', () => {
    for (const id of IDS) expect(CARD_OWN_BOX(id), id).toBe(DESENHADOS(id));
  });

  it('home e tema continuam com caixa, e não escondidos: são mudanças do site todo', () => {
    expect(CARD_OWN_BOX('home')).toBe(true);
    expect(CARD_OWN_BOX('theme')).toBe(true);
  });

  it('o que não tem caixa viaja escondido e marcado', () => {
    for (const id of ['anchors', 'search-links', 'niche', 'page:x', 'other:data/x.json']) expect(CARD_OWN_BOX(id), id).toBe(false);
  });
});
