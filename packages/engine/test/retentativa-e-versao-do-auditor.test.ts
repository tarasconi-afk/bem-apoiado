import { describe, expect, it } from 'vitest';
import { auditorFixPatches } from '../src/stages/reaudit.ts';
import { rulesUseNewEvidence } from '../src/stages/improve.ts';
import { plainOutcome } from '../src/changes.ts';

describe('nova tentativa só escreve se a regra de escolha mudou (09/11, colchão de espuma ou de látex)', () => {
  const known = new Set(['clm_03538692a465', 'clm_0a61647d4d99', 'clm_924071da178b']);
  it('regras só com evidências que já existiam: não reescreve', () => {
    const rules = [{ claim_ids: ['clm_03538692a465', 'clm_0a61647d4d99'] }, { claim_ids: ['clm_924071da178b'] }];
    expect(rulesUseNewEvidence(rules, known)).toBe(false);
  });
  it('uma regra apoiada em evidência nova: reescreve', () => {
    expect(rulesUseNewEvidence([{ claim_ids: ['clm_924071da178b', 'clm_novo'] }], known)).toBe(true);
  });
  it('o desfecho aparece em texto simples para o editor', () => {
    const t = plainOutcome(['pauta "colchão de espuma ou de látex": nova tentativa (já existia)', 'improve: NO_NEW_RULE: 19 evidências novas, nenhuma muda as regras de escolha']);
    expect(t).toContain('não mudaram a regra de escolha');
  });
});

describe('re-auditoria: versão sustentável do auditor como último recurso (09/11, travesseiro de látex)', () => {
  const draft = {
    title: 'T', description: 'D', verdict: { text: 'V', basis: 'evidence', claim_ids: ['a'] },
    sections: [
      { id: 'como-decidir', heading: 'Como decidir', blocks: [
        { kind: 'paragraph', text: 'Regra 0', basis: 'evidence', claim_ids: ['a'] },
        { kind: 'paragraph', text: 'Segundo a Duoflex, o material viscoelástico…', basis: 'evidence', claim_ids: ['b', 'c'] },
      ] },
      { id: 'medidas', heading: 'Medidas', blocks: [{ kind: 'table', columns: ['x'], rows: [{ cells: ['1'] }], claim_ids: ['d'] }] },
    ],
  } as never;
  const fix = 'A Duoflex descreve retorno lento. A Ortobom afirma que sua espuma viscoelástica se adapta aos contornos do corpo.';
  it('usa o texto do auditor no bloco, com as mesmas evidências', () => {
    const p = auditorFixPatches(draft, [{ ref: 'como-decidir#1', msg: 'MISATTRIBUTED. …' }], new Map([['como-decidir#1', fix]]));
    expect(p).toEqual([{ ref: 'como-decidir#1', action: 'replace', text: fix, claim_ids: ['b', 'c'] }]);
  });
  it('não tenta se algum problema não tem versão do auditor, é tabela ou não é bloco', () => {
    expect(auditorFixPatches(draft, [{ ref: 'como-decidir#1', msg: 'x' }], new Map())).toBeNull();
    expect(auditorFixPatches(draft, [{ ref: 'medidas#0', msg: 'x' }], new Map([['medidas#0', fix]]))).toBeNull();
    expect(auditorFixPatches(draft, [{ ref: 'verdict', msg: 'x' }], new Map([['verdict', fix]]))).toBeNull();
    expect(auditorFixPatches(draft, [], new Map())).toBeNull();
  });
});
