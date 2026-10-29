import { describe, expect, it } from 'vitest';
import { keepsReaderValue } from '../src/stages/review.ts';
import { verdictFormOf } from '../src/stages/page.ts';
import { attributeSingleSource } from '../src/stages/structure.ts';

// 29/10: a re-auditoria semanal reescreveu 14 blocos da página do lençol no dia seguinte à aprovação e a deixou
// mais exata e menos útil. O ajuste pelo painel já media a nota de leitor antes e depois e revertia; a
// re-auditoria não media nada e gravava direto sobre a página no ar.
describe('a re-auditoria não pode piorar a página', () => {
  const bom = { answers_primary_query: 'yes' as const, reader_fit: true, quick_answer: true, purchase_path: true };

  it('queda de um ponto inteiro é recusada', () => {
    // Meio ponto é a tolerância (ver o último teste deste bloco), então o caso recusado precisa cair mais:
    // aqui a página deixou de falar com o leigo.
    const pior = { ...bom, reader_fit: false };
    const r = keepsReaderValue(bom, pior, 3, 3);
    expect(r.ok).toBe(false);
    expect(r.before - r.after).toBe(1);
  });

  it('nota igual ou maior passa', () => {
    expect(keepsReaderValue(bom, bom, 2, 2).ok).toBe(true);
  });

  // A válvula: a versão honesta costuma ser mais estreita ("no D28 Guarda Costas, 90 kg" no lugar de "D28
  // suporta 90 kg") e o juiz a acha menos decisiva. Meio ponto é tolerado SE a resposta curta continuar
  // mandando escolher — que é exatamente o que a página do lençol perdeu.
  it('meio ponto a menos passa se a resposta curta continuar mandando escolher', () => {
    const meio = { ...bom, answers_primary_query: 'partial' as const };
    expect(keepsReaderValue(bom, meio, 2, 2).ok).toBe(true);
    expect(keepsReaderValue(bom, meio, 2, 1).ok).toBe(false); // perdeu "escolha"/"se você": não passa
  });
});

// 29/10, toalha de banho: 2 das 4 rodadas morreram em problema de forma, e uma delas foi esta. O gate pedia ao
// redator o que o código sabe fazer sozinho. Cortar frase é remoção: nada novo é afirmado.
describe('resposta curta com mais de 3 frases', () => {
  it('as frases que sobram são cortadas, sem pedir nada ao redator', () => {
    const v = verdictFormOf('Escolha a toalha de banho. A gramatura fica entre 300 e 600 g/m². O tamanho varia de 60 × 120 a 70 × 140 cm. Confira a composição na etiqueta.');
    expect(v).toBe('Escolha a toalha de banho. A gramatura fica entre 300 e 600 g/m². O tamanho varia de 60 × 120 a 70 × 140 cm.');
  });

  it('três frases ou menos ficam intactas', () => {
    const t = 'Escolha a toalha de banho. A gramatura fica entre 300 e 600 g/m². Confira a etiqueta.';
    expect(verdictFormOf(t)).toBe(t);
  });
});

// 29/10, toalha de banho: o bloco citava Inmetro e fabricantes, e a atribuição por código desistia do bloco
// inteiro por causa do regulador. O auditor foi exato: "os trechos do Inmetro sustentam composição, dimensão e
// conservação, NÃO a recomendação de tamanho" — que é dos fabricantes.
describe('bloco que mistura regulador e fabricante', () => {
  const src: Record<string, { publisher: string; source_class: string }> = {
    f: { publisher: 'Appel', source_class: 'manufacturer' },
    r: { publisher: 'Inmetro', source_class: 'regulator' },
  };
  const bloco = (text: string, ids: string[]) => {
    const d = { title: 't', description: 'd', verdict: { text: 'x.', basis: 'framing', claim_ids: [] }, sections: [{ id: 's', heading: 'S', blocks: [{ kind: 'paragraph', text, basis: 'evidence', claim_ids: ids }] }] } as never;
    return (attributeSingleSource(d, (id) => src[id]).draft as never as { sections: { blocks: { text: string }[] }[] }).sections[0]!.blocks[0]!.text;
  };

  it('a afirmação do fabricante ganha fonte mesmo com o regulador citado no mesmo bloco', () => {
    expect(bloco('A toalha de banho mede de 60 × 120 a 70 × 140 cm.', ['f', 'r'])).toBe('A toalha de banho mede de 60 × 120 a 70 × 140 cm, segundo a Appel.');
  });

  // O guarda-corpo: sem ele, atribuir em bloco misto trocaria a fonte de lugar e diria que a exigência legal é
  // do fabricante. É pior que não atribuir.
  it('a frase de norma NÃO recebe o nome do fabricante, mesmo sem nomear o órgão', () => {
    for (const f of ['A etiqueta deve informar o percentual das fibras, conforme a norma NM ISO 3758:2013.', 'A regra exige indicar o tamanho em centímetros.']) {
      expect(bloco(f, ['f', 'r']), f).toBe(f);
    }
  });

  it('frase que já nomeia o regulador fica intacta', () => {
    const f = 'O Inmetro exige o nome das fibras na etiqueta.';
    expect(bloco(f, ['f', 'r'])).toBe(f);
  });
});
