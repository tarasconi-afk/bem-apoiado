import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SourceClass } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { computeLearning } from '../learning.ts';
import { loadNiche } from '../niche.ts';
import { DATA, RUNS_DIR, writeJson } from '../store.ts';
import { domainCandidates, editRegistry, isPublicSuffix, loadRegistry } from './discover.ts';

// Domínios novos avaliados pelo motor (23/10, editor: "prefiro que você avalie esses casos, até aprovando diretamente
// novas fontes, e depois auditando o que foi aprovado caso não faça ou deixe de fazer sentido"). Aprovado à mão por
// engano: oconsumidor.gov.br como "regulador" (é portal de reclamações). O motor decide só com confiança alta; o
// resto continua na lista do editor. Toda decisão fica registrada com motivo e pode ser desfeita no painel. Domínio
// aprovado pelo motor que, lido, não rende evidência é revogado sozinho.

export const DECISIONS_FILE = join(DATA, 'registry', 'decisions.json');
export interface DomainDecision {
  host: string;
  action: 'allow' | 'block' | 'unsure' | 'revoke' | 'undo';
  source_class?: SourceClass;
  publisher?: string;
  confidence?: number;
  reason: string;
  at: string;
  by: 'motor' | 'editor' | 'dev';
}
export const loadDecisions = (): DomainDecision[] => (existsSync(DECISIONS_FILE) ? JSON.parse(readFileSync(DECISIONS_FILE, 'utf8')) : []);
export const recordDecision = (d: DomainDecision) => writeJson(DECISIONS_FILE, [...loadDecisions(), d]);

export const AUTO_CONFIDENCE = 0.85;
const UNSURE_RETRY_DAYS = 30;
export const AUDIT_AFTER_DAYS = 14;

// Páginas desse domínio que apareceram nas buscas (título e endereço): a evidência que o avaliador vê.
function examplesFor(host: string, max = 6): string[] {
  const out: string[] = [];
  if (!existsSync(RUNS_DIR)) return out;
  for (const run of readdirSync(RUNS_DIR)) {
    const f = join(RUNS_DIR, run, 'discover.json');
    if (!existsSync(f)) continue;
    try {
      for (const s of (JSON.parse(readFileSync(f, 'utf8')).suggestions ?? []) as { host: string; url: string; title: string }[]) {
        if (s.host.replace(/^www\./, '') === host && !out.some((x) => x.includes(s.url))) out.push(`${s.title} — ${s.url}`);
        if (out.length >= max) return out;
      }
    } catch {
      continue;
    }
  }
  return out;
}

async function homepage(host: string, f: typeof fetch): Promise<string> {
  try {
    const r = await f(`https://${host}/`, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; BemApoiadoBot/1.0)' } });
    if (!r.ok) return `(página inicial: HTTP ${r.status})`;
    const html = (await r.text()).slice(0, 200_000);
    const pick = (re: RegExp) => re.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    return `título: ${pick(/<title[^>]*>([^<]{0,200})/i)} · descrição: ${pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i)}`;
  } catch {
    return '(página inicial não respondeu)';
  }
}

const Verdict = z.object({
  decision: z.enum(['manufacturer', 'regulator', 'standard_body', 'independent_test', 'block', 'unsure']),
  publisher: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const SYSTEM = () => {
  const n = loadNiche();
  return `Você decide se um domínio pode ser FONTE de um site de guias de compra sobre ${n.scope}, que só aceita fontes primárias. Tipos de produto do site: ${n.product_kinds.filter((k) => k.id !== 'outro').map((k) => k.label).join(', ')}.
Classes:
- manufacturer: site OFICIAL de uma marca que FABRICA produtos desses tipos. Loja que revende várias marcas não é fabricante.
- regulator: órgão público que CRIA ou FISCALIZA regra técnica do produto (ex.: Inmetro, Anvisa, Ministério do Trabalho). Portal de reclamações de consumidor, compras públicas e licitação, prefeitura, tribunal, conselho profissional, agência de outro setor: block.
- standard_body: quem publica norma técnica (ex.: ABNT).
- independent_test: laboratório ou associação que TESTA produtos com método publicado (ex.: Proteste).
- block: loja, marketplace, blog, notícia, ranking ou "melhores", reclamação, fórum, software ou sistema de gestão, indústria de outro setor, consultoria, legislação genérica.
- unsure: as evidências não bastam para decidir.
"publisher": nome curto do dono do site (ex.: "Altenburg", "Inmetro"). "confidence": 0 a 1; acima de 0.85 só se o título da página inicial e as páginas vistas concordam. "reason": uma frase.`;
};

export async function evaluateDomains(opts: { max?: number; fetchImpl?: FetchLike; siteFetch?: typeof fetch; now?: Date } = {}): Promise<DomainDecision[]> {
  const now = opts.now ?? new Date();
  const recent = loadDecisions();
  const askedRecently = (host: string) => recent.some((d) => d.host === host && (d.action !== 'unsure' || now.getTime() - Date.parse(d.at) < UNSURE_RETRY_DAYS * 86_400_000));
  const cands = domainCandidates(RUNS_DIR, loadRegistry()).filter((c) => !isPublicSuffix(c.host) && !askedRecently(c.host)).slice(0, opts.max ?? 5);
  const out: DomainDecision[] = [];
  for (const c of cands) {
    const home = await homepage(c.host, opts.siteFetch ?? fetch);
    const ex = examplesFor(c.host);
    const r = await callJson({ role: 'extractor', system: SYSTEM(), user: `Domínio: ${c.host}\n${home}\nPáginas dele vistas nas buscas (${c.topics.length} pauta(s)):\n${ex.map((e) => `- ${e}`).join('\n') || `- ${c.example.title} — ${c.example.url}`}`, schema: Verdict, schemaName: 'domain_verdict', maxTokens: 300 }, opts.fetchImpl);
    const v = r.data;
    // Mesma trava do aprovar manual: regulador é órgão público (.gov.br); site .gov.br não é fabricante.
    const gov = /\.gov\.br$/.test(c.host);
    if ((v.decision === 'regulator' && !gov) || (v.decision === 'manufacturer' && gov)) { v.reason = `${v.reason} (classe incompatível com o domínio)`; v.confidence = Math.min(v.confidence, 0.5); }
    const base = { host: c.host, confidence: v.confidence, reason: v.reason.slice(0, 240), at: now.toISOString(), by: 'motor' as const };
    let d: DomainDecision;
    if (v.decision === 'unsure' || v.confidence < AUTO_CONFIDENCE) d = { ...base, action: 'unsure', ...(v.decision !== 'unsure' && v.decision !== 'block' ? { source_class: v.decision } : {}), publisher: v.publisher };
    else if (v.decision === 'block') {
      editRegistry('block', c.host);
      d = { ...base, action: 'block' };
    } else {
      try {
        editRegistry('allow', c.host, v.publisher.slice(0, 60), v.decision);
        d = { ...base, action: 'allow', source_class: v.decision, publisher: v.publisher.slice(0, 60) };
      } catch (e) {
        d = { ...base, action: 'unsure', reason: `${base.reason} (não aprovado: ${(e as Error).message.slice(0, 80)})` };
      }
    }
    recordDecision(d);
    out.push(d);
  }
  return out;
}

// Tira o domínio do cadastro (de aprovados e de bloqueados): ele volta à lista de domínios novos.
export function forgetDomain(host: string, path = join(DATA, 'registry', 'domains.json')): boolean {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { allow: { host: string; path?: string }[]; block: string[] };
  const before = raw.allow.length + raw.block.length;
  raw.allow = raw.allow.filter((a) => a.host !== host || !!a.path);
  raw.block = raw.block.filter((b) => b !== host);
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  return raw.allow.length + raw.block.length < before;
}

export function revokeDomain(host: string, reason: string, by: DomainDecision['by'], now = new Date()): boolean {
  if (!forgetDomain(host)) return false;
  editRegistry('block', host);
  recordDecision({ host, action: 'revoke', reason, at: now.toISOString(), by });
  return true;
}

// Auditoria do que o motor aprovou: depois de 14 dias, domínio com 3+ páginas lidas e nenhuma evidência útil é
// revogado (vira bloqueado, com o motivo). O que o editor aprovou à mão não é revogado sozinho.
export function auditApprovedDomains(now = new Date()): DomainDecision[] {
  const learning = computeLearning();
  const reg = loadRegistry();
  const out: DomainDecision[] = [];
  const decisions = loadDecisions();
  for (const d of decisions.filter((x) => x.by === 'motor' && x.action === 'allow')) {
    if (now.getTime() - Date.parse(d.at) < AUDIT_AFTER_DAYS * 86_400_000) continue;
    if (!reg.allow.some((a) => a.host === d.host)) continue;
    if (decisions.some((x) => x.host === d.host && Date.parse(x.at) > Date.parse(d.at))) continue; // já revisto
    const s = learning.domains.get(d.host);
    if (s && s.researched >= 3 && s.productive === 0) {
      const reason = `${s.researched} páginas lidas em ${AUDIT_AFTER_DAYS}+ dias, nenhuma evidência útil`;
      if (revokeDomain(d.host, reason, 'motor', now)) out.push({ host: d.host, action: 'revoke', reason, at: now.toISOString(), by: 'motor' });
    }
  }
  return out;
}
