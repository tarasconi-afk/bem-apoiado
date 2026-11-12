import { describe, expect, it } from 'vitest';
import { citacaoSemAlegacao, firstForbidden } from '@bem-apoiado/core';
import { loadNiche } from '../src/niche.ts';

// 12/11 (decisão comercial do dono): propriedade declarada pelo fabricante entra atribuída e com a nota do regulador;
// promessa de resultado continua proibida.
describe('regra de saúde controlada', () => {
  const F = loadNiche().forbidden_terms;
  it('declaração atribuída com a nota do Inmetro passa nos termos vetados', () => {
    expect(firstForbidden('Se alergia pesa na sua escolha, veja se o fabricante declara o modelo antialérgico: a Plumasul declara os seus antialérgicos e antiácaros; o Inmetro não avalia essa propriedade.', F)).toBeNull();
  });
  it('promessa de resultado reprova', () => {
    expect(firstForbidden('Travesseiro ideal para alérgicos.', F)).not.toBeNull();
    expect(firstForbidden('O tecido previne alergia e combate ácaros.', F)).not.toBeNull();
    expect(firstForbidden('Alivia a dor nas costas.', F)).not.toBeNull();
  });
  it('a regra do nicho descreve a forma permitida e a proibida', () => {
    const r = loadNiche().safety_rule;
    expect(r).toMatch(/declara o modelo antialérgico/);
    expect(r).toMatch(/Inmetro não avalia/);
    expect(r).toMatch(/ideal para quem tem/);
  });
  it('citação: declaração fica, promessa de resultado sai', () => {
    const r = citacaoSemAlegacao('Os travesseiros Plumasul são antialérgicos e anti ácaros. Protegem contra alergias respiratórias. Fronha 50x70.', F);
    expect(r.texto).toBe('Os travesseiros Plumasul são antialérgicos e anti ácaros. Fronha 50x70.');
    expect(r.omitidas).toBe(1);
    expect(citacaoSemAlegacao('Tecido hipoalergênico, ideal para alérgicos.', F).texto).toBe('');
  });
});
