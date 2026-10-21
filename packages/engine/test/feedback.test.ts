import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HumanVerdict, ReviewMetrics } from '@bem-apoiado/core';

process.env.BEM_ROOT = mkdtempSync(join(tmpdir(), 'bem-feedback-'));
writeFileSync(join(process.env.BEM_ROOT, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
const { calibrate, DEFAULT_THRESHOLDS, MIN_LABELS, recordVerdict, ruleDecides } = await import('../src/feedback.ts');

const m = (filler_ratio: number, criteria: number): ReviewMetrics => ({
  answers_primary_query: 'partial', concrete_guidance: true, filler_ratio, criteria, rule_publishable: false,
});
let n = 0;
const v = (verdict: 'approve' | 'reject', review: ReviewMetrics | null, slug = `p${n++}`): HumanVerdict => ({
  slug, verdict, reason: 'motivo', at: `2026-10-20T12:00:${String(n).padStart(2, '0')}.000Z`, run_id: `run_${slug}`, review,
});

describe('calibração da revisão', () => {
  it('regra recusa resposta "no" mesmo com pouco enchimento', () => {
    expect(ruleDecides({ ...m(0, 5), answers_primary_query: 'no' }, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('amostra pequena mede mas não muda a regra', () => {
    const r = calibrate([v('approve', m(0.3, 3)), v('approve', m(0.35, 4))], DEFAULT_THRESHOLDS);
    expect(r.labels).toBe(2);
    expect(r.current.agree).toBe(0);
    expect(r.disagreements).toHaveLength(2);
    expect(r.apply).toBe(false);
  });

  it('com amostra suficiente, afrouxa o enchimento quando o editor aprova páginas a 30-35%', () => {
    const vs = [
      ...Array.from({ length: 5 }, (_, i) => v('approve', m(0.3 + (i % 2) * 0.05, 3))),
      ...Array.from({ length: 4 }, () => v('reject', m(0.45, 3))),
    ];
    expect(vs.length).toBeGreaterThanOrEqual(MIN_LABELS);
    const r = calibrate(vs, DEFAULT_THRESHOLDS);
    expect(r.apply).toBe(true);
    expect(r.best.agree).toBe(9);
    expect(r.best.max_filler_ratio).toBeGreaterThanOrEqual(0.35);
    expect(r.best.max_filler_ratio).toBeLessThan(0.45);
    expect(r.best.min_criteria).toBe(DEFAULT_THRESHOLDS.min_criteria);
  });

  it('vale o veredito mais recente de cada execução e ignora vereditos sem métricas', () => {
    const first = v('reject', m(0.1, 3), 'x');
    const later = { ...v('approve', m(0.1, 3), 'x'), at: '2026-10-21T00:00:00.000Z' };
    const r = calibrate([later, first, v('approve', null)], DEFAULT_THRESHOLDS);
    expect(r.labels).toBe(1);
    expect(r.current.agree).toBe(1);
  });
});

describe('veredito do editor', () => {
  it('recusa: motivo vira nota e lacuna, devolve tentativa e avisa quando pede algo vetado', () => {
    const root = process.env.BEM_ROOT!;
    const real = join(import.meta.dirname, '../../../data');
    for (const d of ['pages', 'topics']) mkdirSync(join(root, 'data', d), { recursive: true });
    copyFileSync(join(real, 'niche.json'), join(root, 'data/niche.json'));
    copyFileSync(join(real, 'pages/colchao-d28-ou-d33.json'), join(root, 'data/pages/colchao-d28-ou-d33.json'));
    const topic = JSON.parse(readFileSync(join(real, 'topics/colchao-d28-ou-d33.json'), 'utf8'));
    writeFileSync(join(root, 'data/topics/colchao-d28-ou-d33.json'), JSON.stringify({ ...topic, evidence_gaps: [], improve_attempts: 2, editorial_notes: [] }));
    const h = recordVerdict('colchao-d28-ou-d33', 'reject', 'faltou falar dos benefícios para a coluna e comparar firmeza');
    expect(h.verdict).toBe('reject');
    const t = JSON.parse(readFileSync(join(root, 'data/topics/colchao-d28-ou-d33.json'), 'utf8'));
    expect(t.editorial_notes[0]).toMatch(/^Editor recusou: /);
    expect(t.editorial_notes[1]).toMatch(/vetado.*"coluna"/);
    expect(t.evidence_gaps).toEqual(['faltou falar dos benefícios para a coluna e comparar firmeza']);
    expect(t.improve_attempts).toBe(1);
    const page = JSON.parse(readFileSync(join(root, 'data/pages/colchao-d28-ou-d33.json'), 'utf8'));
    expect(page.status).toBe('draft');
  });
});

describe('regra de publicação: público', () => {
  it('página que não fala com o leitor leigo não passa; revisão antiga (sem o campo) continua valendo', async () => {
    const { ruleDecides: rd } = await import('../src/feedback.ts');
    const m = { answers_primary_query: 'yes' as const, concrete_guidance: true, filler_ratio: 0.1, criteria: 4, rule_publishable: false };
    const t = { max_filler_ratio: 0.25, min_criteria: 2 };
    expect(rd(m, t)).toBe(true);
    expect(rd({ ...m, reader_fit: false }, t)).toBe(false);
  });
});
