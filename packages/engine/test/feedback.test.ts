import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HumanVerdict, ReviewMetrics } from '@bem-apoiado/core';

process.env.BEM_ROOT = mkdtempSync(join(tmpdir(), 'bem-feedback-'));
writeFileSync(join(process.env.BEM_ROOT, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
const { calibrate, DEFAULT_THRESHOLDS, MIN_LABELS, ruleDecides } = await import('../src/feedback.ts');

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
