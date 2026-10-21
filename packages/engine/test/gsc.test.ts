import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { homeOrder, opportunities, pageStats, signedJwt, type GscSnapshot } from '../src/gsc.ts';

const row = (page: string, query: string, impressions: number, clicks: number, position: number) =>
  ({ page: `https://bemapoiado.com/${page}/`, query, impressions, clicks, ctr: clicks / impressions, position });
const snap = (rows: ReturnType<typeof row>[]): GscSnapshot => ({ site: 'sc-domain:bemapoiado.com', start: '2026-10-01', end: '2026-10-28', fetched_at: '2026-10-31T00:00:00Z', rows });
const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, '-');

describe('Search Console', () => {
  it('JWT da conta de serviço é RS256 válido com escopo só leitura', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = signedJwt({ client_email: 'motor@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.googleapis.com/token' }, 1_800_000_000);
    const [h, c, sig] = jwt.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims.scope).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('agrega por página com posição ponderada e acha oportunidades', () => {
    const s = snap([
      row('colchao-d28-ou-d33', 'colchao d28 ou d33', 300, 2, 12),
      row('colchao-d28-ou-d33', 'qual densidade para 80 kg', 40, 0, 15),
      row('colchao-de-molas-ou-espuma', 'colchao de molas ou espuma', 30, 6, 4),
    ]);
    const st = pageStats(s).get('colchao-d28-ou-d33')!;
    expect(st.impressions).toBe(340);
    expect(st.position).toBeCloseTo((300 * 12 + 40 * 15) / 340, 5);
    const ops = opportunities(s, new Set(['colchao-d28-ou-d33', 'colchao-de-molas-ou-espuma']), new Set(), slug);
    expect(ops.strikingDistance.map((p) => p.slug)).toEqual(['colchao-d28-ou-d33']);
    expect(ops.lowCtr.map((p) => p.slug)).toEqual(['colchao-d28-ou-d33']);
    expect(ops.newTopics.map((t) => t.query)).toEqual(['qual densidade para 80 kg', 'colchao d28 ou d33'].filter((q) => !['colchao-d28-ou-d33'].includes(slug(q))));
    expect(homeOrder(s, ['colchao-d28-ou-d33', 'colchao-de-molas-ou-espuma'])).toEqual(['colchao-de-molas-ou-espuma', 'colchao-d28-ou-d33']);
  });
});
