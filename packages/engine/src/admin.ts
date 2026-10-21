import { loadThresholds, loadVerdicts } from './feedback.ts';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Slug } from '@bem-apoiado/core';
import { renderStatus } from './status.ts';
import { editableBlocks } from './stages/manual-edit.ts';
import { loadClaims } from './store.ts';
import { mkdirSync } from 'node:fs';
import { setReportedBalance } from './credits.ts';
import { domainCandidates, loadRegistry as loadDomainRegistry } from './stages/discover.ts';
import { RUNS_DIR } from './store.ts';
import { GSC_SITE, hasKey, keyEmail, latestSnapshot, opportunities, pageStats, saveKey } from './gsc.ts';
import { loadTopics } from './store.ts';
import { DATA, loadPages, ROOT } from './store.ts';

// Painel admin: o painel de status + ações. Escuta só em 127.0.0.1 atrás do Caddy (HTTPS). A senha
// é conferida aqui (hash scrypt em STATE, fora do git), para o dono poder trocá-la pelo próprio painel.
// Nenhuma ação roda git ou LLM aqui: cada clique vira um job de scripts/painel-acao.sh (validado,
// com o mesmo lock do ciclo) ou um pedido de ciclo para o systemd. Vários cliques não somam trabalho:
// um job por vez.

const PORT = Number(process.env.BEM_PANEL_PORT ?? 8787);
const ORIGIN = process.env.BEM_PANEL_ORIGIN ?? 'https://srv2079501.hstgr.cloud';
const BASE = process.env.BEM_PANEL_BASE ?? '/painel/';
const PREVIEW = process.env.BEM_PREVIEW_URL ?? 'https://srv2079501.hstgr.cloud';
const STATE = process.env.BEM_STATE_DIR ?? '/var/lib/bem-apoiado';
const JOBS_FILE = join(STATE, 'painel-jobs.json');
const RUN_NOW = join(STATE, 'run-now');
const SCRIPT = join(ROOT, 'scripts/painel-acao.sh');
const REPO_URL = 'https://github.com/tarasconi-afk/bem-apoiado';

const AUTH_FILE = join(STATE, 'painel-auth.json');
const MIN_PASSWORD = 12;

interface Auth { user: string; salt: string; hash: string }
const hashOf = (password: string, salt: string) => scryptSync(password, salt, 64).toString('hex');

export function setPassword(password: string, user = 'admin') {
  if (password.length < MIN_PASSWORD) throw new Error(`a senha precisa de pelo menos ${MIN_PASSWORD} caracteres`);
  const salt = randomBytes(16).toString('hex');
  writeFileSync(AUTH_FILE, JSON.stringify({ user, salt, hash: hashOf(password, salt) }), { mode: 0o600 });
}

function passwordOk(user: string, password: string): boolean {
  if (!existsSync(AUTH_FILE)) return false;
  const a: Auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const got = Buffer.from(hashOf(password, a.salt), 'hex');
  return user === a.user && timingSafeEqual(got, Buffer.from(a.hash, 'hex'));
}

// Força bruta: 10 erros seguidos de um IP bloqueiam esse IP por 15 minutos.
const failures = new Map<string, { n: number; until: number }>();
function authorized(req: IncomingMessage): 'ok' | 'locked' | 'no' {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim();
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return 'locked';
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  const [user, ...rest] = m ? Buffer.from(m[1]!, 'base64').toString().split(':') : [];
  if (user !== undefined && passwordOk(user, rest.join(':'))) {
    failures.delete(ip);
    return 'ok';
  }
  if (m) {
    const n = (f?.n ?? 0) + 1;
    failures.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60_000 : 0 });
  }
  return 'no';
}

interface Job {
  id: string;
  label: string;
  args: string[];
  started: string;
  ended?: string;
  code?: number | null;
  output: string;
}

const jobs: Job[] = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, 'utf8')) : [];
const saveJobs = () => writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(0, 30), null, 2));
const running = () => jobs.find((j) => !j.ended);

function startJob(label: string, args: string[]): string | null {
  if (running()) return 'já há uma ação em andamento; espere ela terminar';
  const job: Job = { id: Date.now().toString(36), label, args, started: new Date().toISOString(), output: '' };
  jobs.unshift(job);
  saveJobs();
  const p = spawn('bash', [SCRIPT, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const add = (b: Buffer) => { job.output = (job.output + b.toString()).slice(-4000); };
  p.stdout.on('data', add);
  p.stderr.on('data', add);
  p.on('close', (code) => {
    job.ended = new Date().toISOString();
    job.code = code;
    saveJobs();
  });
  return null;
}

// Ramos do motor ainda não mesclados: resultado de ciclos esperando decisão.
function pendingBranches(): { branch: string; subject: string; when: string; steps: string[] }[] {
  try {
    const out = execFileSync('git', ['for-each-ref', '--no-merged=origin/main', '--sort=-committerdate', '--format=%(refname:short)%1f%(subject)%1f%(committerdate:iso-strict)%1f%(body)%1e', 'refs/remotes/origin/pagina/'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\x1e').map((x) => x.trim()).filter(Boolean).map((l) => {
      const [ref, subject, when, body] = l.split('\x1f');
      // Etapas do ciclo (linhas "- ..." do corpo do commit): o que o motor fez, inclusive quando não gerou página.
      const steps = (body ?? '').split('\n').filter((x) => x.startsWith('- ')).map((x) => x.slice(2));
      return { branch: ref!.replace(/^origin\//, ''), subject: subject ?? '', when: when ?? '', steps };
    });
  } catch {
    return [];
  }
}

function queueItems(): string[] {
  const f = join(DATA, 'queue.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).items.map((i: { query: string }) => i.query) : [];
}

// Link para a página do ramo na prévia: pagina/<slug>-AAAAMMDD-HHMM → /painel/previa/<slug>-.../<slug>/.
function previewLink(branch: string): string {
  const dir = branch.replace(/^pagina\//, '');
  const slug = dir.replace(/-\d{8}-\d{4}$/, '');
  const ready = existsSync(join(PREVIAS, dir, 'index.html'));
  if (!ready) return '<span class="muted">prévia sendo montada (até 5 min)</span>';
  // Tentativa que não gerou página (parou antes) ou manutenção: não há página para ver; a prévia é do site.
  if (!existsSync(join(PREVIAS, dir, slug))) return `<span class="muted">sem página nova para ver</span> · <a href="${BASE}previa/${esc(dir)}/" target="_blank" rel="noopener">site com esta mudança</a>`;
  return `<a href="${BASE}previa/${esc(dir)}/${esc(slug)}/" target="_blank" rel="noopener"><strong>Ver prévia da página</strong></a>`;
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const form = (acao: string, fields: Record<string, string>, button: string, cls = '', confirm?: string) =>
  `<form method="post" action="acao" class="inline"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ''}><input type="hidden" name="acao" value="${acao}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}<button class="${cls}">${button}</button></form>`;

function adminHtml(msg: string | null): string {
  const job = running();
  const pages = loadPages();
  const branches = pendingBranches();
  const queue = queueItems();
  return `
${msg ? `<p class="flash">${esc(msg)}</p>` : ''}
${job ? `<p class="flash">Em andamento: <strong>${esc(job.label)}</strong> desde ${esc(fmt(job.started))}. A página atualiza sozinha.</p>` : ''}

<h2>Pedir ao motor</h2>
${requestsHtml()}

<h2>Esperando sua decisão: resultados do motor</h2>
${branches.length ? `<div class="tw"><table><thead><tr><th>Resultado</th><th>Resumo</th><th>Quando</th><th></th></tr></thead><tbody>${branches.map((b) => `<tr data-pending><td>${previewLink(b.branch)}<br><a class="muted" href="${REPO_URL}/compare/main...${esc(b.branch)}" target="_blank" rel="noopener">diferenças no GitHub</a></td><td>${esc(b.subject)}${suggestionHtml(reviewFrom(readBranch(b.branch), b.branch.replace(/^pagina\//, '').replace(/-\d{8}-\d{4}$/, '')))}${b.steps.length ? `<details><summary class="muted">etapas</summary><ul class="muted">${b.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}</td><td class="muted">${esc(fmt(b.when))}</td><td class="actions">${form('mesclar', { ramo: b.branch }, 'Aceitar', 'ok', 'Aceitar o resultado deste ciclo no main? Página aprovada pela regra vai ao ar no próximo deploy.')}${form('descartar', { ramo: b.branch }, 'Descartar', 'bad', 'Descartar este ramo? A pauta volta para a fila.')}</td></tr>`).join('')}</tbody></table></div>
<p class="muted">Aceitar roda testes, gate e build aqui antes de ir ao main; equivale ao merge do PR.</p>` : '<p class="muted">Nenhum resultado pendente.</p>'}

${verdictsHtml(pages)}

<h2>Domínios novos encontrados nas buscas</h2>
${domainsHtml()}

<h2>Fila de pautas</h2>
<div class="tw"><table><tbody>${queue.map((q, i) => `<tr><td class="num">${i + 1}</td><td>${esc(q)}</td><td class="actions">${form('fila-remover', { consulta: q }, 'Remover', 'bad', `Remover "${q}" da fila?`)}</td></tr>`).join('')}</tbody></table></div>
${ideasHtml()}
<form method="post" action="acao" class="verdict" style="margin-top:10px"><input type="hidden" name="acao" value="fila-adicionar"><input name="consulta" required minlength="3" maxlength="120" placeholder="nova dúvida, como o leitor busca (ex.: colchão firme ou macio)"><button class="ok">Adicionar ao fim</button></form>

<h2>Piloto automático</h2>
<p class="muted">Roda sozinho às 04:00, 10:00, 16:00 e 22:00 (uma página por ciclo). Um ciclo gasta até ${process.env.BEM_CYCLE_BUDGET ?? 40} créditos, e os ciclos do dia somados até ${process.env.BEM_DAILY_CREDIT_CAP ?? 100}.</p>
${form('ciclo', {}, 'Rodar um ciclo agora', 'ok', `Rodar um ciclo agora? Pode gastar até ${process.env.BEM_CYCLE_BUDGET ?? 40} créditos de IA (dentro do teto diário de ${process.env.BEM_DAILY_CREDIT_CAP ?? 100}).`)}

<h2>Google Search Console</h2>
${gscHtml()}

<h2>Saldo de créditos</h2>
<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="saldo">
<input name="saldo" required inputmode="decimal" placeholder="saldo de créditos mostrado no hPanel agora (ex.: 4850)"><button class="ok">Registrar saldo</button></form>
<p class="muted">Basta informar de vez em quando (ex.: depois de recarregar). O painel desconta o gasto real registrado a partir daí.</p>

<h2>Senha do painel</h2>
<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="senha">
<input type="password" name="atual" required autocomplete="current-password" placeholder="senha atual">
<input type="password" name="nova" required minlength="${MIN_PASSWORD}" autocomplete="new-password" placeholder="nova (mín. ${MIN_PASSWORD} caracteres)">
<input type="password" name="confirma" required minlength="${MIN_PASSWORD}" autocomplete="new-password" placeholder="repita a nova">
<button class="ok">Trocar senha</button></form>
<p class="muted">Depois de trocar, o navegador pede a senha nova (usuário continua <code>admin</code>).</p>

${jobs.length ? `<h2>Últimas ações</h2><div class="tw"><table><thead><tr><th>Quando</th><th>Ação</th><th>Resultado</th></tr></thead><tbody>${jobs.slice(0, 10).map((j) => `<tr><td class="muted">${esc(fmt(j.started))}</td><td>${esc(j.label)}</td><td>${!j.ended ? '<span class="b neutral">rodando</span>' : j.code === 0 ? '<span class="b ok">ok</span>' : '<span class="b bad">falhou</span>'}<details><summary class="muted">saída</summary><pre>${esc(j.output.trim() || '(vazia)')}</pre></details></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// Vereditos: só pede decisão do que precisa dela. Rascunho cuja versão atual ainda não foi julgada fica
// em destaque; recusado aguarda o motor; página no ar fica recolhida (com opção de despublicar).
function verdictsHtml(pages: ReturnType<typeof loadPages>): string {
  const verdicts = loadVerdicts();
  const lastFor = (p: (typeof pages)[number]) => verdicts.filter((v) => v.slug === p.slug && v.run_id === p.provenance.run_id).at(-1);
  const editLink = (p: (typeof pages)[number]) => `<a href="${BASE}editar/${esc(p.slug)}">Editar texto</a>`;
  const box = (p: (typeof pages)[number], approve: boolean, label: string) => `<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}"><input name="motivo" required minlength="3" maxlength="400" placeholder="motivo (obrigatório)">${approve ? '<button name="veredito" value="approve" class="ok">Aprovar</button>' : ''}<button name="veredito" value="reject" class="bad">${label}</button></form>`;
  const link = (p: (typeof pages)[number]) => `<a href="${PREVIEW}/${esc(p.slug)}/" target="_blank" rel="noopener">${esc(p.title)}</a>`;
  const drafts = pages.filter((p) => p.status === 'draft');
  const waiting = drafts.filter((p) => !lastFor(p));
  const rejected = drafts.filter((p) => lastFor(p)?.verdict === 'reject');
  const live = pages.filter((p) => p.status !== 'draft');
  return `<h2>Páginas: seu veredito ${waiting.length ? `<span class="b neutral">${waiting.length} aguardando</span>` : ''}</h2>
${waiting.length ? `<p class="muted">Leia na <a href="${PREVIEW}/" target="_blank" rel="noopener">prévia</a>. Aprovar publica; recusar volta ao motor com o motivo como instrução. Cada veredito calibra a revisão automática.</p>
<div class="tw"><table><tbody>${waiting.map((p) => `<tr data-pending><td>${link(p)}${suggestionHtml(reviewFrom(readMain, p.slug))}</td><td>${box(p, true, 'Recusar')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nada aguardando o seu veredito.</p>'}
${rejected.length ? `<p class="muted" style="margin-top:10px">Recusadas, o motor vai tentar de novo: ${rejected.map((p) => `${link(p)} <span class="muted">("${esc(lastFor(p)!.reason.slice(0, 80))}")</span>`).join(' · ')}</p>` : ''}
<details style="margin-top:10px"><summary><strong>${live.length} página(s) no ar</strong> <span class="muted">(despublicar só se achar um problema)</span></summary><div class="tw"><table><tbody>${live.map((p) => `<tr><td>${link(p)}<br>${editLink(p)}</td><td class="muted">atualizada ${esc(p.updated_at)}</td><td>${box(p, false, 'Despublicar')}</td></tr>`).join('')}</tbody></table></div></details>`;
}

// Ideias descobertas sozinhas (autocompletar do Google), ainda fora da fila: um clique põe na fila.
function ideasHtml(): string {
  const f = join(DATA, 'ideas.json');
  if (!existsSync(f)) return '<p class="muted">O ciclo procura pautas novas no autocompletar do Google uma vez por semana.</p>';
  const queued = new Set(queueItems().map((q) => q.toLowerCase()));
  const ideas = (JSON.parse(readFileSync(f, 'utf8')) as { query: string; score: number; status: string; from: string[] }[]).filter((i) => i.status === 'nova' && !queued.has(i.query.toLowerCase())).sort((a, b) => b.score - a.score).slice(0, 15);
  if (!ideas.length) return '';
  return `<details style="margin-top:10px"><summary><strong>${ideas.length} ideias de pauta</strong> <span class="muted">(achadas no autocompletar do Google; o ciclo põe 5 por semana na fila)</span></summary><div class="tw"><table><tbody>${ideas.map((i) => `<tr><td>${esc(i.query)}</td><td class="muted">${esc(i.from.slice(0, 2).join(' · '))}</td><td class="num">${i.score}</td><td class="actions">${form('fila-adicionar', { consulta: i.query }, 'Pôr na fila', 'ok')}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function domainsHtml(): string {
  let cands: ReturnType<typeof domainCandidates> = [];
  try {
    cands = domainCandidates(RUNS_DIR, loadDomainRegistry()).slice(0, 15);
  } catch {
    return '<p class="muted">não foi possível ler os candidatos agora</p>';
  }
  if (!cands.length) return '<p class="muted">Nenhum domínio fora do cadastro apareceu nas buscas.</p>';
  const opts = [['manufacturer', 'Fabricante'], ['regulator', 'Órgão regulador'], ['standard_body', 'Norma técnica'], ['independent_test', 'Teste independente']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  return `<p class="muted">A busca só usa domínios aprovados. <b>Fabricante</b>: site oficial de uma marca (ex.: ortobom.com.br). <b>Órgão regulador</b>: quem cria ou fiscaliza regra (Inmetro, Anvisa, Diário Oficial da União). <b>Norma técnica</b>: quem publica normas (ABNT). <b>Teste independente</b>: laboratório ou associação que testa produto (Proteste). Todo o resto (loja, blog, ranking, reclamação de consumidor, prefeitura, notícia): <b>bloquear</b>.</p>
<div class="tw"><table><thead><tr><th>Domínio</th><th>Visto em</th><th>Exemplo</th><th></th></tr></thead><tbody>${cands.map((c) => `<tr><td><code>${esc(c.host)}</code></td><td class="muted">${c.topics.length} pauta(s), ${c.hits}x</td><td><a href="${esc(c.example.url)}" target="_blank" rel="noopener noreferrer">${esc(c.example.title.slice(0, 70))}</a></td><td>
<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="dominio-aprovar"><input type="hidden" name="host" value="${esc(c.host)}"><input name="publicador" required maxlength="60" placeholder="nome (ex.: Cavaletti)" style="min-width:120px"><select name="classe">${opts}</select><button class="ok">Aprovar</button></form>
${form('dominio-bloquear', { host: c.host }, 'Bloquear', 'bad')}</td></tr>`).join('')}</tbody></table></div>`;
}

function gscHtml(): string {
  if (!hasKey()) {
    return `<p class="muted">Não conectado. Crie a conta de serviço (passo a passo na conversa com o Claude), adicione o e-mail dela como usuário "Restrito" na propriedade <code>${esc(GSC_SITE)}</code> e cole aqui o JSON da chave. Ela fica só na VPS (arquivo 600), nunca no git.</p>
<form method="post" action="acao"><input type="hidden" name="acao" value="gsc-chave">
<p><input type="file" accept=".json,application/json" onchange="const f=this.files[0];if(f){f.text().then(t=>{this.form.chave.value=t;this.form.submit();});}"> <span class="muted">escolha o arquivo .json baixado do Google (envia sozinho)</span></p>
<details><summary class="muted">ou colar o conteúdo</summary><textarea name="chave" rows="4" style="width:100%;font:12px ui-monospace,monospace" placeholder='{"type": "service_account", ...}'></textarea><button class="ok" style="margin-top:6px">Conectar</button></details></form>`;
  }
  const snap = latestSnapshot();
  if (!snap) return `<p class="muted">Conectado como <code>${esc(keyEmail())}</code>. Primeiro retrato no próximo ciclo (o Google leva alguns dias para ter dados de um site novo).</p>`;
  const stats = [...pageStats(snap).values()].sort((a, b) => b.impressions - a.impressions);
  const topics = loadTopics();
  const ops = opportunities(snap, new Set(topics.map((t) => t.slug)), new Set(queueItems().map((q) => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))), (q) => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  return `<p class="muted">Conectado como <code>${esc(keyEmail())}</code> · período ${esc(snap.start)} a ${esc(snap.end)} · ${snap.rows.length} combinações página×busca.</p>
<div class="tw"><table><thead><tr><th>Página</th><th class="num">Cliques</th><th class="num">Impressões</th><th class="num">CTR</th><th class="num">Posição</th><th>Buscas principais</th></tr></thead><tbody>${stats.map((p) => `<tr><td><code>/${esc(p.slug)}/</code></td><td class="num">${p.clicks}</td><td class="num">${p.impressions}</td><td class="num">${pct(p.ctr)}</td><td class="num">${p.position.toFixed(1)}</td><td class="muted">${p.queries.slice(0, 3).map((q) => esc(q.query)).join(' · ')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">sem impressões ainda</td></tr>'}</tbody></table></div>
${ops.strikingDistance.length ? `<p><strong>Quase na 1ª página</strong> (posição 8–20): ${ops.strikingDistance.map((p) => `<code>/${esc(p.slug)}/</code> (${p.position.toFixed(1)})`).join(', ')}. Melhorar estas rende mais que criar páginas novas.</p>` : ''}
${ops.lowCtr.length ? `<p><strong>Aparecem, mas pouco clicadas</strong> (CTR &lt; 1%): ${ops.lowCtr.map((p) => `<code>/${esc(p.slug)}/</code> (${pct(p.ctr)})`).join(', ')}. Título e descrição são o primeiro alvo.</p>` : ''}
${ops.newTopics.length ? `<p><strong>Buscas sem página própria</strong> (o ciclo põe até 2 por semana na fila): ${ops.newTopics.map((t) => `"${esc(t.query)}" (${t.impressions})`).join(', ')}.</p>` : ''}`;
}

// Abas: as seções continuam sendo h2 + conteúdo; o script agrupa cada h2 (e o que vem até o próximo) na
// aba do mapa abaixo. Sem framework, e sem script o painel continua inteiro numa página só.
const TABS_JS = `<script>
(function () {
  var MAP = [['Pedir ao motor','decisoes'],['Esperando sua decisão','decisoes'],['Páginas: seu veredito','decisoes'],['Fila de pautas','conteudo'],['Domínios novos','conteudo'],
    ['Google Search Console','desempenho'],['Qualidade do motor','desempenho'],['Créditos de IA','desempenho'],
    ['Saldo de créditos','config'],['Senha do painel','config']];
  var NAMES = { decisoes: 'Decisões', conteudo: 'Conteúdo', desempenho: 'Desempenho', motor: 'Motor', config: 'Configurações' };
  var main = document.querySelector('main'); if (!main) return;
  var grid = main.querySelector('.grid'); if (!grid) return;
  var panes = {}; var cur = null;
  Object.keys(NAMES).forEach(function (k) { var d = document.createElement('div'); d.className = 'pane'; d.dataset.tab = k; panes[k] = d; });
  var after = false;
  Array.prototype.slice.call(main.children).forEach(function (n) {
    if (n === grid) { after = true; return; }
    if (!after || n.classList.contains('flash')) return;
    if (n.tagName === 'H2') { var t = n.textContent || ''; cur = 'motor'; MAP.forEach(function (m) { if (t.indexOf(m[0]) === 0) cur = m[1]; }); }
    if (cur) panes[cur].appendChild(n);
  });
  var bar = document.createElement('nav'); bar.className = 'tabs';
  var pending = panes.decisoes.querySelectorAll('[data-pending]').length;
  Object.keys(NAMES).forEach(function (k) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = NAMES[k]; b.dataset.tab = k;
    if (k === 'decisoes' && pending) { var s = document.createElement('span'); s.className = 'count'; s.textContent = pending; b.appendChild(s); }
    b.onclick = function () { show(k); }; bar.appendChild(b);
  });
  grid.after(bar); var holder = bar; Object.keys(panes).forEach(function (k) { holder.after(panes[k]); holder = panes[k]; });
  function show(k) { Object.keys(panes).forEach(function (x) { panes[x].hidden = x !== k; }); bar.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === k); }); try { localStorage.setItem('painel-aba', k); } catch (e) {} }
  var saved = null; try { saved = localStorage.getItem('painel-aba'); } catch (e) {}
  show(pending ? 'decisoes' : saved && panes[saved] ? saved : 'decisoes');
})();
</script>`;

// Sugestão do motor (aceitar/recusar) com os motivos da revisão editorial: o editor vê o que não passou e
// pode pedir ajuste. `read` lê um arquivo do repositório (do main ou de um ramo do motor).
type FullReview = { answers_primary_query: string; concrete_guidance: boolean; filler_ratio: number; decision_criteria: string[]; missing: string[]; summary: string; publishable: boolean };
function reviewFrom(read: (path: string) => string | null, slug: string): { review: FullReview; writer: string } | null {
  try {
    const page = JSON.parse(read(`data/pages/${slug}.json`) ?? 'null');
    if (!page) return null;
    const runs = String(page.provenance.run_id).split('+').map((x: string) => x.replace(/^[a-z]+:/, '')).reverse();
    for (const r of runs) {
      const pj = read(`data/runs/${r}/page.json`);
      const rv = pj ? JSON.parse(pj).review : null;
      if (rv) return { review: rv, writer: page.provenance.writer_model };
    }
  } catch {
    /* sem revisão registrada */
  }
  return null;
}
const readMain = (path: string) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null);
const readBranch = (branch: string) => (path: string) => {
  try {
    return execFileSync('git', ['show', `origin/${branch}:${path}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
function suggestionHtml(x: { review: FullReview; writer: string } | null): string {
  if (!x) return '';
  const r = x.review;
  const t = loadThresholds();
  const ok = r.publishable;
  const why = [
    `responde à dúvida: ${r.answers_primary_query === 'yes' ? 'sim' : r.answers_primary_query === 'partial' ? 'em parte' : 'não'}`,
    `enchimento ${Math.round(100 * r.filler_ratio)}% (limite ${Math.round(100 * t.max_filler_ratio)}%)${r.filler_ratio > t.max_filler_ratio ? ' ✗' : ''}`,
    `${r.decision_criteria.length} critérios de decisão (mínimo ${t.min_criteria})${r.decision_criteria.length < t.min_criteria ? ' ✗' : ''}`,
    r.concrete_guidance ? 'orienta o que fazer' : 'não orienta o que fazer ✗',
  ];
  return `<details class="sug"><summary>Sugestão do motor: <span class="b ${ok ? 'ok' : 'bad'}">${ok ? 'aceitar' : 'recusar'}</span> <span class="muted">${esc(why.join(' · '))}</span></summary>
<p class="muted">${esc(r.summary)}</p>${r.missing.length ? `<p class="muted"><strong>Faltou:</strong></p><ul class="muted">${r.missing.slice(0, 5).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}<p class="muted"><strong>Enchimento</strong> = parte dos blocos que a revisão apontou como dispensável (repete outro bloco, só descreve o catálogo de uma marca, transição vazia): sai sem a página perder nada.</p><p class="muted">Redator: ${esc(x.writer)}. Discorda? Aprove ou recuse com o seu motivo; cada veredito calibra a regra. Para pedir ajuste específico, use "Pedir ao motor".</p></details>`;
}

// Pedidos em texto livre (agente): caixa + últimas respostas + pedidos anotados para o desenvolvedor.
function requestsHtml(): string {
  const answers = jobs.filter((j) => j.label.startsWith('pedido:')).slice(0, 3);
  const devFile = join(DATA, 'dev-requests.json');
  const dev = existsSync(devFile) ? (JSON.parse(readFileSync(devFile, 'utf8')) as { summary: string; status: string; at: string }[]).filter((d) => d.status === 'aberto') : [];
  return `<form method="post" action="acao"><input type="hidden" name="acao" value="pedido"><textarea name="texto" required rows="2" style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)" placeholder="Ex.: crie pautas sobre colchão para quem sente calor · deixe a resposta curta do guia de molas mais direta · relatório de gastos da semana"></textarea><button class="ok" style="margin-top:6px">Enviar pedido</button></form>
<p class="muted">O motor transforma o pedido em ações que ele já faz com as travas de sempre (fila, refazer página com instrução, editar texto com auditoria, despublicar, relatório). Mudança de visual, código ou regra fica anotada para o desenvolvedor.</p>
${answers.map((j) => `<div class="flash" style="margin-top:8px"><strong>${esc(j.label.slice(8))}</strong>${!j.ended ? ' <span class="b neutral">pensando…</span>' : ''}<pre>${esc(j.output.split('\n').filter((l) => /^(→|✓|✗)/.test(l)).join('\n') || (j.ended ? j.output.slice(-400) : ''))}</pre></div>`).join('')}
${dev.length ? `<details style="margin-top:8px"><summary class="muted">${dev.length} pedido(s) anotado(s) para o desenvolvedor</summary><ul class="muted">${dev.map((d) => `<li>${esc(d.summary)} <span class="muted">(${esc(d.at.slice(0, 10))})</span></li>`).join('')}</ul></details>` : ''}`;
}

// Tela de edição: um campo por bloco de texto, com as fontes que o bloco cita (que não mudam).
function editHtml(page: ReturnType<typeof loadPages>[number]): string {
  const claims = new Map(loadClaims().map((c) => [c.id, c]));
  const blocks = editableBlocks(page);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Editar: ${esc(page.title)}</title>
<style>body{font:15px/1.5 system-ui;max-width:900px;margin:24px auto;padding:0 16px;background:#f6f5f1;color:#1d1f1c}textarea{width:100%;font:15px/1.5 system-ui;padding:8px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box}.b{background:#fff;border:1px solid #e4e1d8;border-radius:12px;padding:12px 14px;margin:12px 0}.l{font-weight:600;font-size:.85rem;color:#5b6159}.q{font-size:.8rem;color:#6b716a;margin-top:6px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #cfe3d9;background:#e3f1ea;color:#1e5b4c;font-weight:600;cursor:pointer}</style>
<p><a href="${BASE}">← painel</a></p><h1 style="font-size:1.3rem">${esc(page.title)}</h1>
<p style="color:#5b6159">Mude só o texto. As fontes citadas de cada bloco continuam as mesmas, e o auditor confere se o texto novo ainda é sustentado por elas (~0,1 crédito). Se não for, nada é salvo e o motivo aparece em "Últimas ações".</p>
<form method="post" action="${BASE}acao"><input type="hidden" name="acao" value="editar"><input type="hidden" name="slug" value="${esc(page.slug)}">
${blocks.map((b) => `<div class="b"><div class="l">${esc(b.label)}</div><textarea name="b:${esc(b.ref)}" rows="${Math.min(10, Math.ceil(b.text.length / 90) + 1)}">${esc(b.text)}</textarea>${b.claim_ids.length ? `<div class="q">Fontes: ${b.claim_ids.map((id) => `"${esc((claims.get(id)?.quote ?? id).slice(0, 140))}"`).join(' · ')}</div>` : '<div class="q">Frase de contexto (sem fato e sem fonte).</div>'}</div>`).join('')}
<button>Salvar (passa pelo auditor)</button></form>`;
}

const ADMIN_CSS = `<style>
.sug{margin-top:6px}.sug summary{cursor:pointer;font-size:.88rem}.sug ul{margin:4px 0 6px 18px;padding:0}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:22px 0 6px;border-bottom:1px solid var(--line);padding-bottom:8px}
.tabs button{background:transparent;color:var(--muted);border:1px solid transparent;font-weight:600}
.tabs button.on{background:var(--card);color:var(--ink);border-color:var(--line)}
.tabs .count{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;background:var(--badbg);color:var(--bad);font-size:.75rem}
.flash{background:var(--nbg);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
form.inline{display:inline}form.verdict{display:flex;gap:6px;flex-wrap:wrap}form.verdict input{flex:1;min-width:180px}
input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
button{font:inherit;font-size:.85rem;padding:5px 12px;border-radius:7px;border:1px solid var(--line);cursor:pointer;background:var(--nbg);color:var(--n)}
button.ok{background:var(--okbg);color:var(--ok)}button.bad{background:var(--badbg);color:var(--bad)}
td.actions{white-space:nowrap}td.actions form+form{margin-left:6px}pre{white-space:pre-wrap;font-size:.78rem;margin:6px 0 0}
</style>`;

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

const BRANCH = /^pagina\/[a-z0-9-]+$/;
const clean = (s: string | null, max: number) => (s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

// Valida e traduz o formulário em argumentos do script. Nada do usuário passa por shell.
function toJob(f: URLSearchParams): { label: string; args: string[] } | string {
  const acao = f.get('acao');
  if (acao === 'veredito') {
    const slug = f.get('slug') ?? '';
    const v = f.get('veredito');
    const motivo = clean(f.get('motivo'), 400);
    if (!Slug.safeParse(slug).success || (v !== 'approve' && v !== 'reject') || motivo.length < 3) return 'veredito inválido';
    return { label: `${v === 'approve' ? 'aprovar' : 'recusar'} ${slug}`, args: ['veredito', slug, v, motivo] };
  }
  if (acao === 'fila-adicionar' || acao === 'fila-remover') {
    const q = clean(f.get('consulta'), 120);
    if (q.length < 3) return 'consulta inválida';
    return { label: `${acao === 'fila-adicionar' ? 'adicionar à' : 'remover da'} fila: ${q}`, args: [acao, q] };
  }
  if (acao === 'dominio-aprovar' || acao === 'dominio-bloquear') {
    const host = clean(f.get('host'), 100).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return 'domínio inválido';
    if (acao === 'dominio-bloquear') return { label: `bloquear domínio ${host}`, args: ['dominio-bloquear', host] };
    const classe = f.get('classe') ?? '';
    const pub = clean(f.get('publicador'), 60);
    if (!['manufacturer', 'regulator', 'standard_body', 'independent_test'].includes(classe) || pub.length < 2) return 'classe ou nome inválido';
    return { label: `aprovar domínio ${host} (${pub})`, args: ['dominio-aprovar', host, classe, pub] };
  }
  if (acao === 'mesclar' || acao === 'descartar') {
    const ramo = f.get('ramo') ?? '';
    if (!BRANCH.test(ramo)) return 'ramo inválido';
    return { label: `${acao === 'mesclar' ? 'aceitar' : 'descartar'} ${ramo}`, args: [acao, ramo] };
  }
  return 'ação desconhecida';
}

const PREVIAS = join(STATE, 'previas');
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', webp: 'image/webp', avif: 'image/avif', png: 'image/png',
  jpg: 'image/jpeg', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', xml: 'application/xml', txt: 'text/plain; charset=utf-8',
};

// Prévia de ramo (montada pelo sync): arquivos estáticos de STATE/previas/<ramo>/, nunca fora dali.
function servePreview(pathname: string, res: ServerResponse) {
  const rel = decodeURIComponent(pathname.slice('/previa/'.length));
  if (rel.split('/').some((p) => p === '..' || p.startsWith('.'))) return res.writeHead(400).end();
  let file = join(PREVIAS, rel);
  if (!file.startsWith(PREVIAS + '/')) return res.writeHead(400).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('prévia ainda não montada (o sync roda a cada 5 min)');
  res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()!] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const auth = authorized(req);
  if (auth !== 'ok') {
    res.writeHead(auth === 'locked' ? 429 : 401, auth === 'locked' ? {} : { 'www-authenticate': 'Basic realm="Painel Bem Apoiado", charset="UTF-8"' });
    return res.end(auth === 'locked' ? 'muitas tentativas; espere 15 minutos' : 'senha necessária');
  }
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname.startsWith('/previa/')) return servePreview(url.pathname, res);
  if (req.method === 'GET' && url.pathname.startsWith('/editar/')) {
    const page = loadPages().find((p) => p.slug === decodeURIComponent(url.pathname.slice('/editar/'.length)));
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page ? editHtml(page) : 'página não encontrada');
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    // Dados ilegíveis (ex.: cópia no meio de um merge) não derrubam o painel: mostra o erro e as últimas ações.
    let html: string;
    try {
      html = renderStatus(new Date(), { adminHtml: ADMIN_CSS + adminHtml(url.searchParams.get('msg')), refresh: running() ? 10 : 300 }).replace('</body>', `${TABS_JS}</body>`);
    } catch (e) {
      html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="20"><body style="font:15px system-ui;max-width:900px;margin:24px auto;padding:0 16px"><h1>Painel</h1><p><b>Os dados do motor estão ilegíveis agora</b> (${esc((e as Error).message.slice(0, 200))}). O sync limpa a cópia em até 5 min; esta página tenta de novo sozinha.</p>${jobs.slice(0, 5).map((j) => `<pre style="white-space:pre-wrap;background:#f4f1ea;padding:8px">${esc(j.label)} (${j.ended ? `código ${j.code}` : 'rodando'})\n${esc(j.output.slice(-800))}</pre>`).join('')}</body>`;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'POST' && url.pathname === '/acao') {
    // Contra CSRF: o navegador guarda a senha do basic auth; só aceita POST vindo do próprio painel.
    if (req.headers.origin !== ORIGIN) {
      res.writeHead(403);
      return res.end('origem não permitida');
    }
    const f = await readBody(req);
    let msg: string;
    if (f.get('acao') === 'pedido') {
      const texto = (f.get('texto') ?? '').trim().slice(0, 2000);
      if (texto.length < 5) msg = 'escreva o pedido';
      else {
        const dir = join(STATE, 'pedidos');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now().toString(36)}.txt`);
        writeFileSync(file, texto);
        msg = startJob(`pedido: ${texto.slice(0, 60)}`, ['pedido', file]) ?? 'pedido enviado; a resposta aparece abaixo em alguns segundos';
      }
    } else if (f.get('acao') === 'editar') {
      const slug = f.get('slug') ?? '';
      if (!Slug.safeParse(slug).success || !loadPages().some((p) => p.slug === slug)) msg = 'página inválida';
      else {
        const edits: Record<string, string> = {};
        for (const [k, v] of f) if (k.startsWith('b:') && /^[a-z0-9-]+#\d+$|^verdict$/.test(k.slice(2))) edits[k.slice(2)] = v.slice(0, 2000);
        const dir = join(STATE, 'edits');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now().toString(36)}.json`);
        writeFileSync(file, JSON.stringify(edits));
        msg = startJob(`editar ${slug}`, ['editar', slug, file]) ?? `iniciado: editar ${slug} (o auditor confere os blocos alterados; resultado em "Últimas ações")`;
      }
    } else if (f.get('acao') === 'senha') {
      const user = Buffer.from(/^Basic (.+)$/.exec(req.headers.authorization!)![1]!, 'base64').toString().split(':')[0]!;
      const nova = f.get('nova') ?? '';
      if (!passwordOk(user, f.get('atual') ?? '')) msg = 'senha atual não confere';
      else if (nova !== f.get('confirma')) msg = 'a nova senha e a confirmação são diferentes';
      else if (nova.length < MIN_PASSWORD) msg = `a nova senha precisa de pelo menos ${MIN_PASSWORD} caracteres`;
      else {
        setPassword(nova, user);
        msg = 'senha trocada';
      }
    } else if (f.get('acao') === 'gsc-chave') {
      try {
        const k = saveKey(f.get('chave') ?? '');
        msg = `Search Console conectado com ${k.client_email}. Os dados chegam no próximo ciclo.`;
      } catch (e) {
        msg = `chave não aceita: ${(e as Error).message}`;
      }
    } else if (f.get('acao') === 'saldo') {
      const v = Number((f.get('saldo') ?? '').replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 10_000_000) msg = 'saldo inválido';
      else {
        setReportedBalance(v);
        msg = `saldo registrado: ${v.toLocaleString('pt-BR')} créditos`;
      }
    } else if (f.get('acao') === 'ciclo') {
      if (existsSync(RUN_NOW)) msg = 'ciclo já solicitado';
      else {
        writeFileSync(RUN_NOW, new Date().toISOString());
        msg = 'ciclo solicitado; o resultado aparece em "Execuções recentes" e, se houver página, em "Esperando sua decisão"';
      }
    } else {
      const j = toJob(f);
      msg = typeof j === 'string' ? j : (startJob(j.label, j.args) ?? `iniciado: ${j.label}`);
    }
    res.writeHead(303, { location: `${BASE}?msg=${encodeURIComponent(msg)}` });
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

const head = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

export function startAdmin() {
  // Código novo no main (ação do painel, sync, ciclo): sai quando nada está rodando e o systemd
  // (Restart=always) sobe de novo já com o código atualizado. Sem privilégio de reiniciar nada.
  const started = head();
  setInterval(() => {
    if (!running() && head() !== started) process.exit(0);
  }, 60_000).unref();
  createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`erro: ${(e as Error).message}`);
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`painel admin em 127.0.0.1:${PORT}`));
}
