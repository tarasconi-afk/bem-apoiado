import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHit, trafficSummary } from '../src/hits.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
describe('contador de visitas', () => {
  it('descarta robô e lixo; guarda só a origem da referência; ASIN só se válido', () => {
    expect(toHit({ e: 'pv', p: '/' }, '1.2.3.4', 'Googlebot/2.1')).toBeNull();
    expect(toHit({ e: 'pv', p: 'javascript:alert(1)' }, '1.2.3.4', UA)).toBeNull();
    expect(toHit({ e: 'xx', p: '/' }, '1.2.3.4', UA)).toBeNull();
    const h = toHit({ e: 'pv', p: '/colchao-d28-ou-d33/', r: 'https://www.google.com/search?q=colchao+d28' }, '1.2.3.4', UA)!;
    expect(h.r).toBe('google.com');
    expect(JSON.stringify(h)).not.toContain('1.2.3.4');
    expect(toHit({ e: 'pv', p: '/', r: 'https://bemapoiado.com/x/' }, '1.2.3.4', UA)!.r).toBeUndefined();
    expect(toHit({ e: 'aff', p: '/x/', a: 'B081NL5R39' }, '1.2.3.4', UA)!.a).toBe('B081NL5R39');
    expect(toHit({ e: 'aff', p: '/x/', a: '<script>' }, '1.2.3.4', UA)!.a).toBeUndefined();
  });

  it('mesmo visitante no mesmo dia = mesmo código; em outro dia, código novo', () => {
    const a = toHit({ e: 'pv', p: '/' }, '9.9.9.9', UA, new Date('2026-10-21T10:00:00Z'))!.v;
    const b = toHit({ e: 'pv', p: '/' }, '9.9.9.9', UA, new Date('2026-10-21T20:00:00Z'))!.v;
    const c = toHit({ e: 'pv', p: '/' }, '9.9.9.9', UA, new Date('2026-10-22T10:00:00Z'))!.v;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('resumo por página com cliques e taxa', () => {
    const dir = join(process.env.BEM_STATE_DIR!, 'hits');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, '2026-11-02.jsonl');
    for (const x of [{ e: 'pv', p: '/a/', v: '1', r: 'google.com' }, { e: 'pv', p: '/a/', v: '2' }, { e: 'aff', p: '/a/', v: '1', a: 'B081NL5R39' }, { e: 'pv', p: '/b/', v: '1' }])
      appendFileSync(f, JSON.stringify({ t: '2026-11-02T10:00:00Z', ...x }) + '\n');
    const s = trafficSummary(1, new Date('2026-11-02T12:00:00Z'));
    expect(s.views).toBe(3);
    expect(s.clicks).toBe(1);
    expect(s.visitors).toBe(2);
    expect(s.pages[0]).toEqual({ path: '/a/', views: 2, visitors: 2, clicks: 1 });
    expect(s.referrers).toEqual([['google.com', 1]]);
  });
});
