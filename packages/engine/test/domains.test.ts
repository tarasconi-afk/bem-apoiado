import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-dom-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'k';
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
for (const d of ['registry', 'runs/r1', 'topics', 'pages', 'claims', 'sources']) mkdirSync(join(root, 'data', d), { recursive: true });
copyFileSync(join(import.meta.dirname, '../../../data/niche.json'), join(root, 'data/niche.json'));
writeFileSync(join(root, 'data/registry/domains.json'), JSON.stringify({ allow: [], block: [] }));
writeFileSync(join(root, 'data/runs/r1/discover.json'), JSON.stringify({ topic: 'protetor', suggestions: [
  { host: 'www.altenburg.com.br', url: 'https://www.altenburg.com.br/protetor-de-colchao-casal/p', title: 'Protetor de colchão casal Altenburg' },
  { host: 'lojax.com.br', url: 'https://lojax.com.br/colchao-oferta', title: 'Colchão em oferta' },
  { host: 'oconsumidor.gov.br', url: 'https://oconsumidor.gov.br/colchao', title: 'Reclamações sobre colchão' },
  { host: 'catalogonormas.com.br', url: 'https://catalogonormas.com.br/colchao-nbr', title: 'Norma NBR colchão' },
] }));

const answers: Record<string, unknown> = {
  'altenburg.com.br': { decision: 'manufacturer', publisher: 'Altenburg', confidence: 0.95, reason: 'site oficial da marca' },
  'lojax.com.br': { decision: 'block', publisher: 'Loja X', confidence: 0.92, reason: 'loja' },
  'oconsumidor.gov.br': { decision: 'block', publisher: 'Consumidor.gov.br', confidence: 0.9, reason: 'portal de reclamações' },
  'catalogonormas.com.br': { decision: 'regulator', publisher: 'Catálogo', confidence: 0.9, reason: 'normas' },
};
const llm = (async (_u: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const host = /Domínio: (\S+)/.exec(body.messages.at(-1).content)![1]!;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers[host]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
}) as never;
const site = (async () => new Response('<title>Site</title>')) as unknown as typeof fetch;

describe('domínios avaliados pelo motor', () => {
  it('aprova e bloqueia com confiança alta, deixa em dúvida o incompatível, registra o motivo e desfaz', async () => {
    const { evaluateDomains, loadDecisions, forgetDomain, auditApprovedDomains } = await import('../src/stages/domains.ts');
    const ds = await evaluateDomains({ max: 5, fetchImpl: llm, siteFetch: site, now: new Date('2026-10-01T12:00:00Z') });
    const by = Object.fromEntries(ds.map((d) => [d.host, d.action]));
    expect(by).toEqual({ 'altenburg.com.br': 'allow', 'lojax.com.br': 'block', 'oconsumidor.gov.br': 'block', 'catalogonormas.com.br': 'unsure' });
    const reg = JSON.parse(readFileSync(join(root, 'data/registry/domains.json'), 'utf8'));
    expect(reg.allow.map((a: { host: string }) => a.host)).toEqual(['altenburg.com.br']);
    expect(reg.block).toEqual(['lojax.com.br', 'oconsumidor.gov.br']);
    expect(loadDecisions().find((d) => d.host === 'catalogonormas.com.br')!.reason).toMatch(/incompatível/);
    // Não pergunta de novo o que já decidiu (nem o "em dúvida" antes de 30 dias).
    expect(await evaluateDomains({ max: 5, fetchImpl: llm, siteFetch: site, now: new Date('2026-10-05T12:00:00Z') })).toEqual([]);
    // Aprovado que não rende não é revogado sem histórico de leitura.
    expect(auditApprovedDomains(new Date('2026-11-01T12:00:00Z'))).toEqual([]);
    expect(forgetDomain('lojax.com.br')).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'data/registry/domains.json'), 'utf8')).block).toEqual(['oconsumidor.gov.br']);
  });
});
