import { describe, expect, it } from 'vitest';
import { checksId } from '../src/stages/site-audit.ts';
import { COHERENCE_CHECKS } from '../src/stages/coherence.ts';

describe('auditoria do site: lista de verificações (27/10)', () => {
  it('a identidade cobre todas as verificações e não depende da ordem', () => {
    const id = checksId();
    for (const c of COHERENCE_CHECKS) expect(id).toContain(c);
    expect(id).toBe([...COHERENCE_CHECKS].sort().join(','));
  });

  it('muda quando entra uma verificação nova', () => {
    const antes = ['produto_como_solucao', 'dado_de_produto_vira_regra', 'caso_sem_orientacao'].sort().join(',');
    expect(checksId()).not.toBe(antes);
  });
});
