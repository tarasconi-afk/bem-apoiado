import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { creditsSpent, type FetchLike } from '../llm.ts';
import { buildIndex, loadPages, readState, STATE_DIR, writeState } from '../store.ts';
import { auditCoherence, COHERENCE_CHECKS, type CoherenceFinding } from './coherence.ts';
import { loadTopic } from './research.ts';

// Auditoria do site pelo botão do painel (camada 1 do ROADMAP F, 26/10): passa a coerência (coherence.ts) nas páginas
// no ar, da auditada há mais tempo para a mais recente, até o teto de créditos. Página com problema ganha um pedido
// de ajuste só nos blocos apontados, com a frase de conserto; o script transforma cada pedido em resultado no quadro.
// Não muda nada sozinha: o editor aplica ou descarta cada cartão.

export const SITE_AUDIT_FILE = 'site-audit.json';
const RECHECK_DAYS = 14;
// Página que saiu da auditoria COM problema volta à fila bem antes. 27/10: três páginas tiveram o ajuste
// descartado (ele apagava evidência) e, marcadas como auditadas no dia, sumiriam da fila por 14 dias com o
// problema no ar. Página limpa é estável e espera os 14 dias; página com achado aberto é reconferida em 2.
const RECHECK_DAYS_WITH_FINDINGS = 2;
export const recheckDays = (findings: CoherenceFinding[]): number => (findings.length ? RECHECK_DAYS_WITH_FINDINGS : RECHECK_DAYS);
const PER_PAGE_ESTIMATE = 1; // créditos por página auditada (medido: ~0,7)

// Que verificações a página já levou. 27/10: entraram "secao_nao_entrega" e "promessa_do_titulo" e a rodada só olhou
// 5 páginas, pulando 20 auditadas no dia anterior; das 5, 4 tinham problema das verificações novas. Página auditada
// com uma lista mais curta volta para a fila mesmo dentro dos 14 dias.
export const checksId = (): string => [...COHERENCE_CHECKS].sort().join(',');

export interface SiteAuditEntry { at: string; findings: CoherenceFinding[]; checks?: string }
export interface SiteAuditResult {
  audited: { slug: string; findings: CoherenceFinding[] }[];
  skipped: number; // auditadas há menos de 14 dias
  left: number; // ficaram para a próxima rodada (teto)
  adjustments: { slug: string; file: string; refs: string[] }[];
}

// Pedido de ajuste a partir dos achados: o mesmo formato da correção automática dos rascunhos.
export function auditRequest(findings: CoherenceFinding[]): { text: string; refs: string[] } {
  const usable = findings.filter((f) => !f.ref.includes('.r'));
  return {
    text: usable.map((f) => `No bloco ${f.ref}: ${f.problem.replace(/[.\s]+$/, '')}. Conserto: ${f.fix}`).join(' '),
    refs: [...new Set(usable.map((f) => f.ref))],
  };
}

export async function auditSite(maxCredits: number, now = new Date(), fetchImpl?: FetchLike): Promise<SiteAuditResult> {
  const state = readState<Record<string, SiteAuditEntry>>(SITE_AUDIT_FILE, {});
  const id = checksId();
  const recent = (slug: string) => {
    const e = state[slug];
    return !!e && e.checks === id && now.getTime() - Date.parse(e.at) < recheckDays(e.findings ?? []) * 86_400_000;
  };
  const live = loadPages().filter((p) => p.status !== 'draft');
  const due = live.filter((p) => !recent(p.slug)).sort((a, b) => (state[a.slug]?.at ?? '').localeCompare(state[b.slug]?.at ?? ''));
  const idx = buildIndex();
  const start = creditsSpent();
  const out: SiteAuditResult = { audited: [], skipped: live.length - due.length, left: 0, adjustments: [] };
  const dir = join(STATE_DIR, 'pedidos');
  mkdirSync(dir, { recursive: true });
  for (const [i, p] of due.entries()) {
    if (creditsSpent() - start + PER_PAGE_ESTIMATE > maxCredits) {
      out.left = due.length - i;
      break;
    }
    const c = await auditCoherence(p, loadTopic(p.slug).primary_query, idx.claims, idx.sources, fetchImpl);
    state[p.slug] = { at: now.toISOString(), findings: c.findings, checks: id };
    writeState(SITE_AUDIT_FILE, state);
    out.audited.push({ slug: p.slug, findings: c.findings });
    const req = auditRequest(c.findings);
    if (req.refs.length) {
      const file = join(dir, `auditoria-${p.slug}.txt`);
      writeFileSync(file, req.text);
      out.adjustments.push({ slug: p.slug, file, refs: req.refs });
    }
  }
  return out;
}
