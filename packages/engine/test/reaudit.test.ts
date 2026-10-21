import { describe, expect, it } from 'vitest';
import type { PageSpec } from '@bem-apoiado/core';
import { nextReaudit } from '../src/stages/reaudit.ts';
import { MODELS } from '../src/models.ts';

const pg = (slug: string, status: PageSpec['status'], updated_at = '2026-10-01') => ({ slug, status, updated_at }) as PageSpec;

describe('fila de re-auditoria', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  it('pega a publicada nunca re-auditada pelo auditor atual, ignora rascunho', () => {
    const p = nextReaudit([pg('rascunho', 'draft', '2026-01-01'), pg('a', 'approved', '2026-10-10'), pg('b', 'approved', '2026-10-05')], {}, now);
    expect(p?.slug).toBe('b');
  });
  it('não repete antes de 30 dias com o mesmo auditor; repete se o auditor mudou', () => {
    const recent = { at: '2026-10-15T00:00:00Z', model: MODELS.auditor.id };
    expect(nextReaudit([pg('a', 'approved')], { a: recent }, now)).toBeUndefined();
    expect(nextReaudit([pg('a', 'approved')], { a: { ...recent, model: 'gpt-5.6-sol' } }, now)?.slug).toBe('a');
  });
});
