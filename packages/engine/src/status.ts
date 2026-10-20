import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaim, checkPage, checkProduct, type Violation } from '@bem-apoiado/core';
import { MODELS } from './models.ts';
import { creditsThisMonth, MONTHLY_CREDIT_CAP } from './search.ts';
import { computeLearning } from './learning.ts';
import { rawIntact } from './snapshot.ts';
import { buildIndex, DATA, loadPages, loadProducts, RUNS_DIR } from './store.ts';

// Painel só-leitura: tudo vem de data/ (o mesmo estado que o motor usa). Nenhuma ação é possível daqui.

interface RunRow {
  id: string;
  when: Date;
  topic: string;
  stage: string;
  status: string;
  detail: string;
  credits: number | null;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function collectRuns(): RunRow[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((d) => /^\d{8}T\d{6}_/.test(d))
    .map((id) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})_(.+)_[a-f0-9]{4}$/.exec(id);
      const when = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : new Date(0);
      const dir = join(RUNS_DIR, id);
      const page = readJson(join(dir, 'page.json'));
      const research = readJson(join(dir, 'research.json'));
      if (page) {
        const rounds = page.rounds ? `${page.rounds} rodada(s)` : '';
        const reason = page.reason ? String(page.reason).slice(0, 120) : '';
        return { id, when, topic: m?.[7] ?? id, stage: 'página', status: page.status, detail: [rounds, reason].filter(Boolean).join(' · '), credits: page.credits ?? null };
      }
      if (research) {
        const cov = Object.values(research.coverage ?? {}) as number[];
        return {
          id, when, topic: m?.[7] ?? id, stage: 'pesquisa',
          status: research.errors?.length ? 'COM_ERROS' : 'OK',
          detail: `${research.accepted?.length ?? 0} evidências aceitas, ${research.rejected?.length ?? 0} rejeitadas, ${cov.filter((n) => n > 0).length}/${cov.length} perguntas cobertas`,
          credits: research.credits ?? null,
        };
      }
      return { id, when, topic: m?.[7] ?? id, stage: '?', status: 'INCOMPLETO', detail: 'sem registro final', credits: null };
    })
    .sort((a, b) => b.when.getTime() - a.when.getTime());
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const cr = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

export function renderStatus(now = new Date()): string {
  const runs = collectRuns();
  const idx = buildIndex();
  const pages = loadPages();
  const violations: Violation[] = [];
  for (const s of idx.sources.values()) if (!rawIntact(s)) violations.push({ code: 'SOURCE_RAW_CORRUPT', where: s.id, detail: '' });
  for (const c of idx.claims.values()) violations.push(...checkClaim(c, idx));
  for (const p of pages) violations.push(...checkPage(p, idx));
  const products = loadProducts();
  for (const p of products) violations.push(...checkProduct(p, idx, now));

  const since = (h: number) => runs.filter((r) => now.getTime() - r.when.getTime() < h * 3600_000);
  const sum = (rs: RunRow[]) => rs.reduce((t, r) => t + (r.credits ?? 0), 0);
  const unknownCost = runs.filter((r) => r.credits === null).length;

  const topicsDir = join(DATA, 'topics');
  const topics = existsSync(topicsDir) ? readdirSync(topicsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
  const lastRunFor = (slug: string) => runs.find((r) => r.topic === slug && r.stage === 'página');

  const badge = (s: string) => {
    const cls = /PASS|OK|approved|published/.test(s) ? 'ok' : /SAFE_STOP|ERRO|INCOMPLETO|fail/.test(s) ? 'bad' : 'neutral';
    return `<span class="b ${cls}">${esc(s)}</span>`;
  };

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="300">
<title>Painel do motor</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1f2421;--muted:#626862;--line:#e3ded4;--ok:#2d6a4f;--okbg:#e5f2ea;--bad:#a23b2a;--badbg:#fbe9e5;--n:#5d5a52;--nbg:#efede7}
@media (prefers-color-scheme:dark){:root{--bg:#161817;--card:#1f2220;--ink:#e8eae6;--muted:#a3aaa3;--line:#333834;--okbg:#1d3328;--ok:#7fd1a3;--badbg:#3a1f1a;--bad:#f0a191;--nbg:#2a2c29;--n:#c9c6bc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 10px}
.muted{color:var(--muted);font-size:.88rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card .v{font-size:1.6rem;font-weight:650}.card .l{color:var(--muted);font-size:.82rem}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;min-width:640px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;font-weight:600}.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}.neutral{background:var(--nbg);color:var(--n)}
.num{text-align:right;font-variant-numeric:tabular-nums}code{font-size:.82rem}
</style></head><body><main>
<h1>Painel do motor · Bem Apoiado</h1>
<p class="muted">Gerado em ${esc(fmt(now))} (horário de Brasília) · atualiza a cada 5 min · somente leitura</p>
<div class="grid">
<div class="card"><div class="v">${pages.filter((p) => p.status !== 'draft').length}</div><div class="l">páginas aprovadas</div></div>
<div class="card"><div class="v">${topics.length}</div><div class="l">pautas cadastradas</div></div>
<div class="card"><div class="v">${cr(sum(since(24)))}</div><div class="l">créditos nas últimas 24 h</div></div>
<div class="card"><div class="v">${cr(sum(since(24 * 7)))}</div><div class="l">créditos em 7 dias</div></div>
<div class="card"><div class="v">${idx.sources.size} / ${idx.claims.size}</div><div class="l">fontes / evidências</div></div>
<div class="card"><div class="v">${products.length}</div><div class="l">produtos no catálogo</div></div>
<div class="card"><div class="v">${creditsThisMonth()} / ${MONTHLY_CREDIT_CAP}</div><div class="l">buscas Tavily no mês (teto)</div></div>
<div class="card"><div class="v">${violations.length === 0 ? '0' : `<span style="color:var(--bad)">${violations.length}</span>`}</div><div class="l">violações no gate</div></div>
</div>
${unknownCost ? `<p class="muted">${unknownCost} execução(ões) anteriores ao registro de custo aparecem sem créditos; o extrato do hPanel é a referência final.</p>` : ''}

<h2>Pautas</h2>
<div class="tw"><table><thead><tr><th>Pauta</th><th>Página</th><th>Atualizada</th><th>Última execução</th></tr></thead><tbody>
${topics.map((t) => {
  const p = pageBySlug.get(t);
  const r = lastRunFor(t);
  return `<tr><td><code>${esc(t)}</code></td><td>${p ? badge(p.status) : badge('sem página')}</td><td>${p ? esc(p.updated_at) : '—'}</td><td>${r ? `${badge(r.status)} <span class="muted">${esc(fmt(r.when))}</span>` : '—'}</td></tr>`;
}).join('')}
</tbody></table></div>

<h2>Execuções recentes</h2>
<div class="tw"><table><thead><tr><th>Quando</th><th>Pauta</th><th>Etapa</th><th>Resultado</th><th>Detalhe</th><th class="num">Créditos</th></tr></thead><tbody>
${runs.slice(0, 40).map((r) => `<tr><td>${esc(fmt(r.when))}</td><td><code>${esc(r.topic)}</code></td><td>${esc(r.stage)}</td><td>${badge(r.status)}</td><td class="muted">${esc(r.detail)}</td><td class="num">${r.credits === null ? '—' : cr(r.credits)}</td></tr>`).join('')}
</tbody></table></div>

${violations.length ? `<h2>Violações no gate</h2><div class="tw"><table><thead><tr><th>Código</th><th>Onde</th><th>Detalhe</th></tr></thead><tbody>${violations.slice(0, 50).map((v) => `<tr><td>${esc(v.code)}</td><td><code>${esc(v.where)}</code></td><td class="muted">${esc(v.detail)}</td></tr>`).join('')}</tbody></table></div>` : ''}

<h2>Aprendizado: o que cada domínio rendeu</h2>
<p class="muted">Calculado de todo o histórico. A busca prioriza domínios com rendimento alto e evita páginas que já se mostraram inúteis.</p>
<div class="tw"><table><thead><tr><th>Domínio</th><th class="num">Fontes lidas</th><th class="num">Com evidência</th><th class="num">Evidências</th><th class="num">Em página aprovada</th><th class="num">Citações inventadas barradas</th><th class="num">Rendimento</th></tr></thead><tbody>
${[...computeLearning().domains.values()].sort((a, b) => b.claims - a.claims).map((d) => `<tr><td><code>${esc(d.host)}</code></td><td class="num">${d.researched}</td><td class="num">${d.productive}</td><td class="num">${d.claims}</td><td class="num">${d.cited_in_approved}</td><td class="num">${d.rejected_quotes}</td><td class="num">${Math.round(d.yield * 100)}%</td></tr>`).join('')}
</tbody></table></div>

<h2>Modelos em uso</h2>
<div class="tw"><table><thead><tr><th>Papel</th><th>Modelo</th><th class="num">Créditos / 1M entrada</th><th class="num">Créditos / 1M saída</th></tr></thead><tbody>
${Object.entries(MODELS).map(([role, m]) => `<tr><td>${esc(role)}</td><td><code>${esc(m.id)}</code></td><td class="num">${m.price[0]}</td><td class="num">${m.price[1]}</td></tr>`).join('')}
</tbody></table></div>
</main></body></html>`;
}
