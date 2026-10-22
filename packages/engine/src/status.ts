import { creditsToday, DAILY_CREDIT_CAP } from './stages/autopilot.ts';
import { execFileSync } from 'node:child_process';
import { trafficSummary } from './hits.ts';
import { auditStats } from './lessons.ts';
import { calibrate, loadVerdicts, MIN_LABELS } from './feedback.ts';
import type { PageSpec } from '@bem-apoiado/core';
import { balanceNow, ledger, spendBy } from './credits.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaim, checkPage, checkProduct, type Violation } from '@bem-apoiado/core';
import { MODELS } from './models.ts';
import { creditsThisMonth, MONTHLY_CREDIT_CAP } from './search.ts';
import { computeLearning } from './learning.ts';
import { rawIntact } from './snapshot.ts';
import { buildIndex, DATA, loadPages, loadProducts, ROOT, RUNS_DIR, STATE_DIR } from './store.ts';

// Painel de status: tudo vem de data/ (o mesmo estado que o motor usa). As ações (admin.ts) entram
// como um bloco extra; sem ele, a página é só leitura.

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
const cr1 = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const sumMap = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + v, 0);
const LABELS: Record<string, string> = { writer: 'Redação', auditor: 'Auditoria e revisão', extractor: 'Extração de trechos', imagem: 'Imagens', jev: 'Triagem (Jev)', outro: 'Outros' };

// Ciclo ao vivo: faixa no topo enquanto roda; depois, o resultado do último ciclo (log se falhou).
function cycleLiveHtml(now: Date): string {
  const c = readJson(join(STATE_DIR, 'cycle-live.json')) as { state: string; started?: string; ended?: string; updated?: string; stage?: string; steps?: string[]; code?: number } | null;
  if (!c) return '';
  const mins = (iso?: string) => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000)) : 0);
  const STAGE: Record<string, string> = { discover: 'procurando fontes', research: 'lendo fontes e extraindo trechos', audit: 'auditando', write: 'escrevendo', trim: 'cortando enchimento', page: 'revisão editorial', edit: 'edição final', escalation: 'segunda tentativa com o Sonnet', salvage: 'salvando a página', 'refresh-products': 'renovando produtos' };
  // Diz o que e de qual página: "re-auditando <página> (rodada 3)"; a última etapa concluída mostra a pauta da vez.
  const round = c.stage && /-r(\d+)$/.exec(c.stage) ? ` (rodada ${Number(/-r(\d+)$/.exec(c.stage)![1]) + 1})` : '';
  const reaudit = c.stage ? /^reaudit-(.+?)(-r\d+)?$/.exec(c.stage) : null;
  const stage = !c.stage ? 'começando' : reaudit ? `re-auditando ${reaudit[1]}${round}` : (STAGE[c.stage.replace(/-r\d+$/, '')] ?? c.stage) + round;
  const last = (c.steps ?? []).slice(-3).map((s) => `<li>${esc(s)}</li>`).join('');
  if (c.state === 'rodando' && mins(c.updated) < 90) return `<div class="flash" style="border-color:var(--ok)"><strong>Ciclo em andamento</strong> há ${mins(c.started)} min · agora: ${esc(stage)} <span class="muted">(última atividade há ${mins(c.updated)} min)</span>${last ? `<ul class="muted">${last}</ul>` : ''}</div>`;
  const log = existsSync(join(STATE_DIR, 'cycle-last.log')) ? readFileSync(join(STATE_DIR, 'cycle-last.log'), 'utf8') : '';
  return `<details class="flash" style="${c.state === 'falhou' ? 'border-color:var(--bad)' : ''}"><summary><strong>Último ciclo:</strong> ${c.state === 'falhou' ? '<span class="b bad">falhou</span>' : c.state === 'rodando' ? '<span class="b bad">parou sem terminar</span>' : '<span class="b ok">terminou</span>'} <span class="muted">${esc(fmt(new Date(c.ended ?? c.updated ?? now.toISOString())))}</span></summary>${(c.steps ?? []).length ? `<ul class="muted">${(c.steps ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${c.state !== 'ok' && log ? `<pre style="white-space:pre-wrap;font-size:.75rem">${esc(log.slice(-2500))}</pre>` : ''}</details>`;
}

// Aviso quando o site público ficou para trás do main (sync grava STATE/live-site.json a cada 5 min).
// Só o build do Action carimba a versão; commit de dados do painel também conta como versão nova.
function liveWarning(): string {
  const s = readJson(join(STATE_DIR, 'live-site.json')) as { checked_at: string; live: string; main: string; main_at?: string } | null;
  if (!s || !s.live || s.live === s.main) return '';
  // Implantação leva alguns minutos depois de cada envio ao main: só avisa se passou de 15 min.
  if (s.main_at && Date.parse(s.checked_at) - Date.parse(s.main_at) < 15 * 60_000) return '';
  return `<p class="flash" style="border-color:var(--bad)">Site público em versão antiga (<code>${esc(s.live.slice(0, 7))}</code>; main em <code>${esc(s.main.slice(0, 7))}</code>, conferido ${esc(fmt(new Date(s.checked_at)))}). Mais de 15 min: a implantação automática da Hostinger não disparou (hPanel → Sites → Git → Implantar).</p>`;
}

// Versão que está rodando (último commit do main na VPS): o editor sabe se o envio mais recente já chegou.
function versionLine(): string {
  try {
    const [sha, at, subject] = execFileSync('git', ['log', '-1', '--format=%h%x1f%cI%x1f%s'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\x1f');
    return `<br>Versão em uso: último envio ao main em <strong>${esc(fmt(new Date(at!)))}</strong> <span title="${esc(subject)}">(<code>${esc(sha)}</code>: ${esc(subject!.slice(0, 70))}${subject!.length > 70 ? '…' : ''})</span>`;
  } catch {
    return '';
  }
}

export function renderStatus(now = new Date(), opts: { adminHtml?: string; refresh?: number } = {}): string {
  const runs = collectRuns();
  const idx = buildIndex();
  const pages = loadPages();
  const violations: Violation[] = [];
  for (const s of idx.sources.values()) if (!rawIntact(s)) violations.push({ code: 'SOURCE_RAW_CORRUPT', where: s.id, detail: '' });
  for (const c of idx.claims.values()) violations.push(...checkClaim(c, idx));
  for (const p of pages) violations.push(...checkPage(p, idx));
  const products = loadProducts();
  const cal = calibrate(loadVerdicts());
  const led = ledger();
  const q = auditStats();
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((t, x) => t + x, 0) / xs.length).toFixed(1) : '—');
  const bal = balanceNow(led);
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
<meta name="robots" content="noindex,nofollow">${opts.adminHtml ? '' : `<meta http-equiv="refresh" content="${opts.refresh ?? 300}">`}
<title>Painel do motor</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1f2421;--muted:#626862;--line:#e3ded4;--ok:#2d6a4f;--okbg:#e5f2ea;--bad:#a23b2a;--badbg:#fbe9e5;--n:#5d5a52;--nbg:#efede7}
a{color:var(--ok)}a:visited{color:var(--ok)}
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
<p class="muted">Gerado em ${esc(fmt(now))} (horário de Brasília) · ${opts.adminHtml ? 'ações registradas no git' : 'atualiza a cada 5 min · somente leitura'}${versionLine()}</p>
<div class="grid">
${goalsCard(pages, sum(since(24 * 7)), now)}
<div class="card"><div class="v">${cr(creditsToday())} <span style="font-size:.9rem;font-weight:500">de ${DAILY_CREDIT_CAP}</span></div><div class="l">créditos hoje (teto do dia; zera à meia-noite)</div></div>
<div class="card"><div class="v">${topics.length}</div><div class="l">pautas cadastradas</div></div>
<div class="card"><div class="v">${cr(sum(since(24 * 7)))}</div><div class="l">créditos em 7 dias (${cr(sum(since(24)))} nas últimas 24 h)</div></div>
<div class="card"><div class="v">${idx.sources.size} / ${idx.claims.size}</div><div class="l">fontes / evidências</div></div>
<div class="card"><div class="v">${products.length}</div><div class="l">produtos no catálogo</div></div>
<div class="card"><div class="v">${creditsThisMonth()} / ${MONTHLY_CREDIT_CAP}</div><div class="l">buscas Tavily no mês (teto)</div></div>
<div class="card"><div class="v">${violations.length === 0 ? '0' : `<span style="color:var(--bad)">${violations.length}</span>`}</div><div class="l">violações no gate</div></div>
</div>
${cycleLiveHtml(now)}
${liveWarning()}
${opts.adminHtml ?? ''}
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

<h2>Créditos de IA</h2>
<p class="muted">Valor cobrado pelo próprio roteador em cada chamada (livro-caixa desde ${led.length ? esc(fmt(new Date(led[0]!.at))) : 'hoje'}). O roteador não informa saldo: o saldo abaixo é o último valor informado do hPanel menos o gasto registrado depois dele.</p>
<div class="grid">
<div class="card"><div class="v">${bal.estimate === null ? '—' : cr(bal.estimate)}</div><div class="l">${bal.reported ? `saldo estimado (informado ${esc(fmt(new Date(bal.reported.reported_at)))}: ${cr(bal.reported.reported)})` : 'saldo: informe o valor do hPanel'}</div></div>
<div class="card"><div class="v">${cr1(sumMap(spendBy(led, 24 * 3600_000)))}</div><div class="l">cobrado nas últimas 24 h</div></div>
<div class="card"><div class="v">${cr1(sumMap(spendBy(led, 7 * 24 * 3600_000)))}</div><div class="l">cobrado em 7 dias</div></div>
</div>
${led.length ? `<div class="tw" style="margin-top:12px"><table><thead><tr><th>Categoria (7 dias)</th><th class="num">Créditos</th><th class="num">%</th></tr></thead><tbody>${[...spendBy(led, 7 * 24 * 3600_000)].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(LABELS[k] ?? k)}</td><td class="num">${cr1(v)}</td><td class="num">${Math.round((100 * v) / Math.max(sumMap(spendBy(led, 7 * 24 * 3600_000)), 1e-9))}%</td></tr>`).join('')}</tbody></table></div>` : ''}

<h2>Visitas (contador próprio, sem cookie)</h2>
${(() => {
  const w = trafficSummary(7, now);
  const m = trafficSummary(30, now);
  if (!m.views && !m.clicks) return '<p class="muted">Ainda sem visitas registradas. Conta páginas vistas e cliques na Amazon (cartões de produto e buscas); robôs ficam de fora.</p>';
  return `<div class="grid">
<div class="card"><div class="v">${w.views}</div><div class="l">páginas vistas em 7 dias (${m.views} em 30)</div></div>
<div class="card"><div class="v">${w.visitors}</div><div class="l">visitantes por dia somados em 7 dias</div></div>
<div class="card"><div class="v">${w.clicks}</div><div class="l">cliques na Amazon em 7 dias (${w.productClicks} em cartões, ${w.searchClicks} em buscas)</div></div>
<div class="card"><div class="v">${w.views ? `${((100 * w.clicks) / w.views).toFixed(1)}%` : '—'}</div><div class="l">cliques na Amazon por página vista</div></div>
</div>
<div class="tw" style="margin-top:12px"><table><thead><tr><th>Página (30 dias)</th><th class="num">Vistas</th><th class="num">Visitantes</th><th class="num">Cliques Amazon</th><th class="num">Cartão / busca</th><th class="num">Taxa</th></tr></thead><tbody>${m.pages.slice(0, 20).map((p) => `<tr><td><code>${esc(p.path)}</code></td><td class="num">${p.views}</td><td class="num">${p.visitors}</td><td class="num">${p.clicks}</td><td class="num">${p.productClicks} / ${p.searchClicks}</td><td class="num">${p.views ? `${((100 * p.clicks) / p.views).toFixed(1)}%` : '—'}</td></tr>`).join('')}</tbody></table></div>
${m.referrers.length ? `<p class="muted">De onde vieram (30 dias): ${m.referrers.map(([h, n]) => `${esc(h)} ${n}`).join(' · ')}</p>` : ''}`;
})()}

<h2>Qualidade do motor (60 dias)</h2>
<p class="muted">Quanto menos problemas na 1ª rodada, menos remendos pagos e mais páginas aprovadas de primeira. Os erros mais comuns do auditor entram no prompt do redator a cada página.</p>
<div class="grid">
<div class="card"><div class="v">${q.attempts ? `${Math.round((100 * q.passed) / q.attempts)}%` : '—'}</div><div class="l">tentativas de página aprovadas (${q.passed}/${q.attempts})</div></div>
<div class="card"><div class="v">${avg(q.firstRoundIssues)}</div><div class="l">problemas por página na 1ª auditoria (média)</div></div>
<div class="card"><div class="v">${avg(q.rounds)}</div><div class="l">rodadas por tentativa (média)</div></div>
<div class="card"><div class="v">${avg(q.credits)}</div><div class="l">créditos por página aprovada (média)</div></div>
</div>
${q.byType.size ? `<p class="muted">Erros do auditor: ${[...q.byType].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${esc(k)} ${v.n}`).join(' · ')}</p>` : ''}

<h2>Calibração da revisão</h2>
<p class="muted">Vereditos do editor (<code>verdict &lt;slug&gt; approve|reject --reason "…"</code>) contra a regra automática. Os limites só mudam com ${MIN_LABELS} ou mais vereditos e ganho real de concordância.</p>
<div class="grid">
<div class="card"><div class="v">${cal.labels}</div><div class="l">vereditos do editor</div></div>
<div class="card"><div class="v">${cal.labels ? `${cal.current.agree}/${cal.labels}` : '—'}</div><div class="l">regra concorda com o editor</div></div>
<div class="card"><div class="v">≤ ${Math.round(cal.current.max_filler_ratio * 100)}% · ≥ ${cal.current.min_criteria}</div><div class="l">limites atuais (enchimento · critérios)</div></div>
</div>
${cal.disagreements.length ? `<div class="tw" style="margin-top:12px"><table><thead><tr><th>Pauta</th><th>Editor</th><th>Regra</th><th>Quando</th></tr></thead><tbody>${cal.disagreements.map((d) => `<tr><td><code>${esc(d.slug)}</code></td><td>${badge(d.human === 'approve' ? 'approved' : 'recusada')}</td><td>${esc(d.rule ? 'publicar' : 'não publicar')}</td><td class="muted">${esc(fmt(new Date(d.at)))}</td></tr>`).join('')}</tbody></table></div>` : ''}

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

// Metas do editor (22/10): 20 páginas para ganhar tração, 200 no fim. "Sem ajuste" = página no ar sem pedido de
// ajuste do editor (o que mede se o motor acerta de primeira); créditos por página = gasto de 7 dias dividido
// pelas aprovações dos mesmos 7 dias.
export function goalsCard(pages: Pick<PageSpec, 'status' | 'provenance' | 'slug'>[], spent7d: number, now: Date): string {
  const live = pages.filter((p) => p.status !== 'draft');
  // Rascunho que o editor recusou não espera decisão: o cartão separa os dois (22/10: "3 em rascunho" eram as 3
  // recusadas, e o editor procurou onde aprovar).
  const lastVerdict = new Map<string, string>();
  for (const v of loadVerdicts().sort((a, b) => a.at.localeCompare(b.at))) lastVerdict.set(v.slug, v.verdict);
  const draftSlugs = pages.filter((p) => p.status === 'draft').map((p) => p.slug);
  const rejected = draftSlugs.filter((s) => lastVerdict.get(s) === 'reject').length;
  const waitingYou = draftSlugs.length - rejected;
  const clean = live.filter((p) => !/\+editor:(?!\d{8}T\d{6}_autopilot_)/.test(String(p.provenance.run_id))).length; // manutenção automática não conta
  // Concordância do juiz automático com o editor nos últimos 10 vereditos: é o número que diz quando a revisão
  // pode passar a decidir sozinha (modo sombra antes de qualquer publicação automática).
  // Com a nota do juiz ATUAL (data/judge-rescore.json), quando existe: a guardada em cada veredito é a do juiz
  // da época e fazia o cartão dizer 4 de 9 quando o juiz atual concordava em 6 de 8 (22/10).
  const rescoreFile = join(DATA, 'judge-rescore.json');
  const rescore = existsSync(rescoreFile) ? (JSON.parse(readFileSync(rescoreFile, 'utf8')).pages as Record<string, { editor: string; judge_publish: boolean }>) : null;
  const judgedOld = loadVerdicts().filter((v) => v.review).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  const judged = rescore ? Object.values(rescore) : judgedOld;
  const agree = rescore
    ? Object.values(rescore).filter((r) => (r.editor === 'approve') === r.judge_publish).length
    : judgedOld.filter((v) => (v.verdict === 'approve') === v.review!.rule_publishable).length;
  const approved7d = loadVerdicts().filter((v) => v.verdict === 'approve' && now.getTime() - new Date(v.at).getTime() < 7 * 86_400_000).length;
  const goal = live.length < 20 ? 20 : 200;
  const pct = Math.min(100, Math.round((100 * live.length) / goal));
  return `<div class="card" style="grid-column:span 2"><div class="v">${live.length} <span style="font-size:.9rem;font-weight:500">de ${goal} páginas no ar${goal === 20 ? ' (meta final 200)' : ''}</span></div>
<div style="height:8px;background:var(--nbg);border-radius:999px;margin:6px 0"><div style="height:8px;width:${pct}%;background:var(--ok);border-radius:999px"></div></div>
<div class="l">${waitingYou ? `${waitingYou} rascunho(s) esperando seu veredito · ` : ''}${rejected ? `${rejected} recusada(s) que o motor vai refazer · ` : ''}${clean} de ${live.length} no ar sem ajuste seu · juiz automático concorda com você em ${agree} de ${judged.length} vereditos${rescore ? ' (juiz atual)' : ''} · ${approved7d ? `~${Math.round(spent7d / approved7d)} créditos por página aprovada (7 dias)` : 'sem aprovação nos últimos 7 dias'}</div></div>`;
}
