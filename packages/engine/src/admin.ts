import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Slug } from '@bem-apoiado/core';
import { renderStatus } from './status.ts';
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
function pendingBranches(): { branch: string; subject: string; when: string }[] {
  try {
    const out = execFileSync('git', ['for-each-ref', '--no-merged=origin/main', '--sort=-committerdate', '--format=%(refname:short)|%(subject)|%(committerdate:iso-strict)', 'refs/remotes/origin/pagina/'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map((l) => {
      const [ref, subject, when] = l.split('|');
      return { branch: ref!.replace(/^origin\//, ''), subject: subject ?? '', when: when ?? '' };
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
  const target = existsSync(join(PREVIAS, dir, slug)) ? `${slug}/` : '';
  return ready ? `<a href="${BASE}previa/${esc(dir)}/${esc(target)}" target="_blank" rel="noopener"><strong>Ver prévia da página</strong></a>` : '<span class="muted">prévia sendo montada (até 5 min)</span>';
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

<h2>Esperando sua decisão: resultados do motor</h2>
${branches.length ? `<div class="tw"><table><thead><tr><th>Resultado</th><th>Resumo</th><th>Quando</th><th></th></tr></thead><tbody>${branches.map((b) => `<tr><td>${previewLink(b.branch)}<br><a class="muted" href="${REPO_URL}/compare/main...${esc(b.branch)}" target="_blank" rel="noopener">diferenças no GitHub</a></td><td>${esc(b.subject)}</td><td class="muted">${esc(fmt(b.when))}</td><td class="actions">${form('mesclar', { ramo: b.branch }, 'Aceitar', 'ok', 'Aceitar o resultado deste ciclo no main? Página aprovada pela regra vai ao ar no próximo deploy.')}${form('descartar', { ramo: b.branch }, 'Descartar', 'bad', 'Descartar este ramo? A pauta volta para a fila.')}</td></tr>`).join('')}</tbody></table></div>
<p class="muted">Aceitar roda testes, gate e build aqui antes de ir ao main; equivale ao merge do PR.</p>` : '<p class="muted">Nenhum resultado pendente.</p>'}

<h2>Páginas: seu veredito</h2>
<p class="muted">Leia na <a href="${PREVIEW}/" target="_blank" rel="noopener">prévia</a> (mostra rascunhos). Aprovar publica no próximo deploy; recusar volta a rascunho e o motivo vira instrução para o motor tentar de novo. Cada veredito calibra a revisão automática.</p>
<div class="tw"><table><thead><tr><th>Página</th><th>Situação</th><th>Veredito</th></tr></thead><tbody>
${pages.map((p) => `<tr><td><a href="${PREVIEW}/${esc(p.slug)}/" target="_blank" rel="noopener">${esc(p.title)}</a></td><td><span class="b ${p.status === 'draft' ? 'neutral' : 'ok'}">${esc(p.status === 'draft' ? 'rascunho' : p.status)}</span></td><td>
<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}">
<input name="motivo" required minlength="3" maxlength="400" placeholder="motivo (obrigatório)">
${p.status === 'draft' ? '<button name="veredito" value="approve" class="ok">Aprovar</button>' : ''}<button name="veredito" value="reject" class="bad">Recusar</button></form></td></tr>`).join('')}
</tbody></table></div>

<h2>Fila de pautas</h2>
<div class="tw"><table><tbody>${queue.map((q, i) => `<tr><td class="num">${i + 1}</td><td>${esc(q)}</td><td class="actions">${form('fila-remover', { consulta: q }, 'Remover', 'bad', `Remover "${q}" da fila?`)}</td></tr>`).join('')}</tbody></table></div>
<form method="post" action="acao" class="verdict" style="margin-top:10px"><input type="hidden" name="acao" value="fila-adicionar"><input name="consulta" required minlength="3" maxlength="120" placeholder="nova dúvida, como o leitor busca (ex.: colchão firme ou macio)"><button class="ok">Adicionar ao fim</button></form>

<h2>Piloto automático</h2>
<p class="muted">Roda sozinho todo dia às 04:00. Um ciclo custa até 120 créditos (teto diário 150).</p>
${form('ciclo', {}, 'Rodar um ciclo agora', 'ok', 'Rodar um ciclo agora? Pode gastar até 120 créditos de IA.')}

<h2>Senha do painel</h2>
<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="senha">
<input type="password" name="atual" required autocomplete="current-password" placeholder="senha atual">
<input type="password" name="nova" required minlength="${MIN_PASSWORD}" autocomplete="new-password" placeholder="nova (mín. ${MIN_PASSWORD} caracteres)">
<input type="password" name="confirma" required minlength="${MIN_PASSWORD}" autocomplete="new-password" placeholder="repita a nova">
<button class="ok">Trocar senha</button></form>
<p class="muted">Depois de trocar, o navegador pede a senha nova (usuário continua <code>admin</code>).</p>

${jobs.length ? `<h2>Últimas ações</h2><div class="tw"><table><thead><tr><th>Quando</th><th>Ação</th><th>Resultado</th></tr></thead><tbody>${jobs.slice(0, 10).map((j) => `<tr><td class="muted">${esc(fmt(j.started))}</td><td>${esc(j.label)}</td><td>${!j.ended ? '<span class="b neutral">rodando</span>' : j.code === 0 ? '<span class="b ok">ok</span>' : '<span class="b bad">falhou</span>'}<details><summary class="muted">saída</summary><pre>${esc(j.output.trim() || '(vazia)')}</pre></details></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

const ADMIN_CSS = `<style>
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
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    const html = renderStatus(new Date(), { adminHtml: ADMIN_CSS + adminHtml(url.searchParams.get('msg')), refresh: running() ? 10 : 300 });
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
    if (f.get('acao') === 'senha') {
      const user = Buffer.from(/^Basic (.+)$/.exec(req.headers.authorization!)![1]!, 'base64').toString().split(':')[0]!;
      const nova = f.get('nova') ?? '';
      if (!passwordOk(user, f.get('atual') ?? '')) msg = 'senha atual não confere';
      else if (nova !== f.get('confirma')) msg = 'a nova senha e a confirmação são diferentes';
      else if (nova.length < MIN_PASSWORD) msg = `a nova senha precisa de pelo menos ${MIN_PASSWORD} caracteres`;
      else {
        setPassword(nova, user);
        msg = 'senha trocada';
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
