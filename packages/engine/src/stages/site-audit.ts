import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { creditsSpent, type FetchLike } from '../llm.ts';
import { buildIndex, loadPages, readState, STATE_DIR, writeState } from '../store.ts';
import { auditCoherence, type CoherenceFinding } from './coherence.ts';
import { loadTopic } from './research.ts';

// Auditoria do site pelo botão do painel (camada 1 do ROADMAP F, 26/10): passa a coerência (coherence.ts) nas páginas
// no ar, da auditada há mais tempo para a mais recente, até o teto de créditos. Página com problema ganha um pedido
// de ajuste só nos blocos apontados, com a frase de conserto; o script transforma cada pedido em resultado no quadro.
// Não muda nada sozinha: o editor aplica ou descarta cada cartão.

export const SITE_AUDIT_FILE = 'site-audit.json';
const RECHECK_DAYS = 14;
const PER_PAGE_ESTIMATE = 1; // créditos por página auditada (medido: ~0,7)

export interface SiteAuditEntry { at: string; findings: CoherenceFinding[] }
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
  const recent = (slug: string) => state[slug] && now.getTime() - Date.parse(state[slug]!.at) < RECHECK_DAYS * 86_400_000;
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
    state[p.slug] = { at: now.toISOString(), findings: c.findings };
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
