import { describe, expect, it } from 'vitest';
import { citacaoSemAlegacao } from '../src/text.ts';

const F = ['coluna', 'dor', 'postura', 'saúde', 'antialérg', 'hipoalergên', 'cervical', 'lombar', 'anatômic'];
describe('citação sem alegação de saúde (12/11)', () => {
  it('tira só a frase com o termo vetado e conta a omissão', () => {
    const r = citacaoSemAlegacao('Enchimento 100% penas de ganso. Promove o alinhamento ideal da coluna para um sono mais saudável. Fronha 50x70 cm.', F);
    expect(r.texto).toBe('Enchimento 100% penas de ganso. Fronha 50x70 cm.');
    expect(r.omitidas).toBe(1);
  });
  it('citação inteira com alegação fica vazia', () => {
    const r = citacaoSemAlegacao('Os travesseiros são antialérgicos e anti ácaros.', F);
    expect(r.texto).toBe('');
    expect(r.omitidas).toBe(1);
  });
  it('nome de modelo e peça não é alegação: cervical, lombar, saúde e anatômico ficam', () => {
    expect(citacaoSemAlegacao('NASA X Cervical, fronha 45x65. Apoio lombar ajustável em altura. Pró Saúde Extra suporta 120 kg.', F).omitidas).toBe(0);
  });
  it('"médicos recomendam" sai mesmo sem termo da lista', () => {
    expect(citacaoSemAlegacao('Médicos e fisioterapeutas recomendam trocar a cada dois anos. Acumula poeira.', F).texto).toBe('Acumula poeira.');
  });
  it('"apoio cervical" é alegação pelo contexto; "NASA X Cervical" continua nome (12/11)', () => {
    const r = citacaoSemAlegacao('Encosto com apoio cervical regulável. Tecido mesh. NASA X Cervical 50x70.', F);
    expect(r.texto).toBe('Tecido mesh. NASA X Cervical 50x70.');
    expect(r.omitidas).toBe(1);
  });
});
