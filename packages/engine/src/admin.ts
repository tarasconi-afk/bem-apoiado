import { loadThresholds, loadVerdicts } from './feedback.ts';
import { readerScore } from './stages/review.ts';
import { classifyBranch, classifyDraft, KIND_LABEL, rulesFromNotes, SUGGESTION_LABEL, SUGGESTION_ORDER, type Suggestion } from './board.ts';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Slug } from '@bem-apoiado/core';
import { renderStatus } from './status.ts';
import { lessonId, loadEditorLessons } from './editor-lessons.ts';
import { loadNiche } from './niche.ts';
import { gitChanges, plainOutcome, type ChangeItem } from './changes.ts';
import { queueStatus } from './stages/autopilot.ts';
import { editableBlocks } from './stages/manual-edit.ts';
import { loadClaims } from './store.ts';
import { mkdirSync } from 'node:fs';
import { setReportedBalance } from './credits.ts';
import { domainCandidates, loadRegistry as loadDomainRegistry } from './stages/discover.ts';
import { RUNS_DIR } from './store.ts';
import { GSC_SITE, hasKey, keyEmail, latestSnapshot, opportunities, pageStats, saveKey } from './gsc.ts';
import { loadTopics } from './store.ts';
import { DATA, loadPages, loadProducts, ROOT } from './store.ts';
import { trafficSummary } from './hits.ts';
import { loadAnnounce } from './announce.ts';

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
// O painel lê os dados de uma cópia só de leitura do main (BEM_ROOT=/opt/bem-apoiado/view), atualizada no fim de
// cada ação e de cada sync; ações e ciclos trabalham na cópia de trabalho (BEM_REPO). Assim o painel não mostra
// dados de um resultado no meio de um ajuste (21/10: "5 páginas", ajuste mandado para o lugar errado).
const REPO = process.env.BEM_REPO ?? ROOT;
const SCRIPT = join(REPO, 'scripts/painel-acao.sh');
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
  started: string; // quando foi pedida (entrou na fila)
  queued?: boolean; // esperando a vez
  ran_at?: string; // quando começou a rodar
  ended?: string;
  code?: number | null;
  output: string;
}

const jobs: Job[] = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, 'utf8')) : [];

// Último pedido de ajuste da página falhou ("NÃO salvo")? Aprovar assim publicaria sem o que o editor pediu
// (22/10: a D33 ou D45 foi aprovada sem a tabela porque o aviso passou despercebido). Os jobs vêm do mais novo.
export function failedAdjust(list: Job[], slug: string): string | null {
  const j = list.find((x) => x.args[0] === 'ajustar' && x.args[2] === slug);
  if (!j || !j.ended || (j.code === 0 && !/NÃO salvo/.test(j.output))) return null;
  return (j.output.split('\n').reverse().find((l) => /NÃO salvo|Error|motivo/.test(l)) ?? 'o ajuste falhou').slice(0, 200);
}
const failedNote = (slug: string) => {
  const why = failedAdjust(jobs, slug);
  return why ? `<p class="flash bad-flash">O último ajuste pedido para esta página <strong>não foi salvo</strong>: ${esc(why)}. Peça de novo antes de aprovar, ou marque "aprovar assim mesmo".</p>` : '';
};
const forceBox = (slug: string) => (failedAdjust(jobs, slug) ? '<label class="muted"><input type="checkbox" name="forcar" value="1"> aprovar assim mesmo, sem o ajuste</label>' : '');
// Painel reiniciado no meio de uma ação: ela não tem mais processo; marca como interrompida.
for (const j of jobs) if (!j.ended && !j.queued) Object.assign(j, { ended: new Date().toISOString(), code: -1, output: `${j.output}\n(interrompida: o painel reiniciou)` });
const saveJobs = () => writeFileSync(JOBS_FILE, JSON.stringify(jobs.filter((j) => j.queued).concat(jobs.filter((j) => !j.queued).slice(0, 30)), null, 2));
const running = () => jobs.find((j) => !j.ended && !j.queued);
const queuedJobs = () => jobs.filter((j) => j.queued).reverse(); // mais antiga primeiro
// Ciclo do agendador em andamento (status gravado pelo cycle.sh/motor): painel atualiza a cada 10 s.
const cycleRunning = () => {
  try {
    const c = JSON.parse(readFileSync(join(STATE, 'cycle-live.json'), 'utf8'));
    return c.state === 'rodando' && Date.now() - Date.parse(c.updated) < 90 * 60_000;
  } catch {
    return false;
  }
};

// Fila de ações (21/10: "já há uma ação em andamento" obrigava o editor a esperar). Toda ação entra na
// fila e roda uma por vez, na ordem; durante um ciclo, espera (a trava é a mesma). Ação que achou a trava
// ocupada (código 75 do script) volta para a fila e tenta de novo em 1 min.
const BUSY = 75;
let pumpTimer: NodeJS.Timeout | null = null;
function pump(delayMs = 0): void {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    if (running()) return;
    const next = queuedJobs()[0];
    if (!next) return;
    if (cycleRunning()) return pump(30_000);
    run(next);
  }, delayMs);
}

function run(job: Job): void {
  job.queued = false;
  job.ran_at = new Date().toISOString();
  saveJobs();
  // A ação trabalha na cópia de trabalho: o BEM_ROOT do painel (cópia só de leitura) não pode vazar para ela
  // (21/10: aplicar/prévia leram a cópia atrasada e a prévia saiu sem o rascunho novo).
  const p = spawn('bash', [SCRIPT, ...job.args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BEM_ROOT: REPO } });
  const add = (b: Buffer) => { job.output = (job.output + b.toString()).slice(-4000); };
  p.stdout.on('data', add);
  p.stderr.on('data', add);
  p.on('close', (code) => {
    if (code === BUSY) {
      Object.assign(job, { queued: true, ran_at: undefined, output: `${job.output}\n(motor ocupado; volta a tentar em 1 min)\n` });
      saveJobs();
      return pump(60_000);
    }
    job.ended = new Date().toISOString();
    job.code = code;
    saveJobs();
    pump();
  });
}

function startJob(label: string, args: string[]): string | null {
  const job: Job = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, args, started: new Date().toISOString(), queued: true, output: '' };
  jobs.unshift(job);
  saveJobs();
  pump();
  return null;
}
pump();

// Ramos do motor ainda não mesclados: resultado de ciclos esperando decisão.
function pendingBranches(): { branch: string; subject: string; when: string; steps: string[]; cost: number | null }[] {
  try {
    const out = execFileSync('git', ['for-each-ref', '--no-merged=origin/main', '--sort=-committerdate', '--format=%(refname:short)%1f%(subject)%1f%(committerdate:iso-strict)%1f%(body)%1e', 'refs/remotes/origin/pagina/'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\x1e').map((x) => x.trim()).filter(Boolean).map((l) => {
      const [ref, subject, when, body] = l.split('\x1f');
      // Etapas do ciclo (linhas "- ..." do corpo do commit): o que o motor fez, inclusive quando não gerou página.
      const steps = (body ?? '').split('\n').filter((x) => x.startsWith('- ')).map((x) => x.slice(2));
      const cost = /Custo do ciclo:\*\* ~([\d.]+)/.exec(body ?? '')?.[1];
      return { branch: ref!.replace(/^origin\//, ''), subject: subject ?? '', when: when ?? '', steps, cost: cost ? Number(cost) : null };
    });
  } catch {
    return [];
  }
}

const stateBadge = (st?: string) => (st ? `<span class="b ${st === 'próxima' ? 'ok' : st === 'no ar' ? 'neutral' : st === 'esgotada' || st === 'falhou no planejamento' || st === 'faltam fabricantes' || st === 'adiada (falta fonte)' ? 'bad' : 'neutral'}">${esc(st)}</span>` : '');

function queueItems(): string[] {
  const f = join(DATA, 'queue.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).items.map((i: { query: string }) => i.query) : [];
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
  const pendingSlugs = new Set(branches.map((b) => b.branch.replace(/^pagina\//, '').replace(/-\d{8}-\d{4}$/, '')));
  const qstate = new Map(queueStatus(pendingSlugs).map((x) => [x.query, x.state]));
  return `
${msg ? `<p class="flash">${esc(msg)}</p>` : ''}
${job ? `<p class="flash">Em andamento: <strong>${esc(job.label)}</strong> desde ${esc(fmt(job.ran_at ?? job.started))}. A página atualiza sozinha. Até terminar, os números do topo podem mostrar os dados do resultado que está sendo ajustado.</p>` : ''}
${queuedJobs().length ? `<p class="flash">Na fila (${queuedJobs().length}): ${queuedJobs().map((j) => esc(j.label)).join(' · ')}${cycleRunning() ? '. Começam quando o ciclo em andamento terminar.' : '.'}</p>` : ''}

${boardHtml(pages, branches)}

<h2>Páginas no ar</h2>
${livePagesHtml(pages)}

<h2>Pedir ao motor</h2>
${requestsHtml()}

<h2>Domínios novos encontrados nas buscas</h2>
${domainsHtml()}

<h2>Fila de pautas</h2>
<p class="muted">A fila não perde itens: o motor pega a primeira pauta marcada como <b>próxima</b> e pula as que já estão no ar, esperando você ou esgotadas (sem lacuna nova para pesquisar).</p>
<div class="tw"><table><tbody>${queue.map((q, i) => `<tr><td class="num">${i + 1}</td><td>${esc(q)}</td><td>${stateBadge(qstate.get(q))}</td><td class="actions">${form('fila-remover', { consulta: q }, 'Remover', 'bad', `Remover "${q}" da fila?`)}</td></tr>`).join('')}</tbody></table></div>
${ideasHtml()}
<form method="post" action="acao" class="verdict" style="margin-top:10px"><input type="hidden" name="acao" value="fila-adicionar"><input name="consulta" required minlength="3" maxlength="120" placeholder="nova dúvida, como o leitor busca (ex.: colchão firme ou macio)"><button class="ok">Adicionar ao fim</button></form>

<h2>Produtos à venda</h2>
${productsHtml()}

<h2>Piloto automático</h2>
<p class="muted">Roda sozinho às 04:00, 10:00, 16:00 e 22:00 (uma página por ciclo). Um ciclo gasta até ${process.env.BEM_CYCLE_BUDGET ?? 40} créditos, e os ciclos automáticos do dia somados até ${process.env.BEM_DAILY_CREDIT_CAP ?? 100}. O ciclo pedido aqui não conta esse teto diário enquanto houver menos de 20 páginas no ar.</p>
${form('ciclo', {}, 'Rodar um ciclo agora', 'ok', `Rodar um ciclo agora? Pode gastar até ${process.env.BEM_CYCLE_BUDGET ?? 40} créditos de IA (até 20 páginas no ar, fora do teto diário).`)}

<h2>Detalhe técnico dos resultados</h2>
<p class="muted">Para diagnóstico: cada item de cada resultado do motor, inclusive o que é só aprendizado. As decisões ficam no Quadro (aba Decisões) e as páginas no ar, na aba Páginas.</p>
<details class="old"><summary class="muted">abrir o detalhe de cada resultado</summary>
<h3>Resultados do motor</h3>
${(branches.length ? branches.map(pendingHtml).join('') : '<p class="muted">Nenhum resultado pendente.</p>').replaceAll('data-pending', '')}
${verdictsHtml(pages).replaceAll('data-pending', '').replace(/<h2>/g, '<h3>').replace(/<\/h2>/g, '</h3>')}
</details>

<h2>Google Search Console</h2>
${gscHtml()}
${announceHtml()}

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

${jobs.length ? `<h2>Últimas ações</h2><div class="tw"><table><thead><tr><th>Quando</th><th>Ação</th><th>Resultado</th></tr></thead><tbody>${jobs.slice(0, 10).map((j) => `<tr><td class="muted">${esc(fmt(j.started))}</td><td>${esc(j.label)}</td><td>${j.queued ? '<span class="b neutral">na fila</span>' : !j.ended ? '<span class="b neutral">rodando</span>' : j.code === 0 ? '<span class="b ok">ok</span>' : '<span class="b bad">falhou</span>'}<details><summary class="muted">saída</summary><pre>${esc(j.output.trim() || '(vazia)')}</pre></details></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// Um resultado do motor como lista do que muda no site, item por item (desmarcado = não entra). O que
// não aparece no site (fontes, evidências, rascunho) vai junto como aprendizado, sem pedir decisão.
function pendingHtml(b: ReturnType<typeof pendingBranches>[number]): string {
  const dir = b.branch.replace(/^pagina\//, '');
  const slug = dir.replace(/-\d{8}-\d{4}$/, '');
  let items: ChangeItem[] = [];
  let learning: string[] = [];
  try {
    ({ items, learning } = gitChanges(`origin/${b.branch}`).summary);
  } catch {
    learning = ['não foi possível ler as mudanças deste resultado'];
  }
  const ready = existsSync(join(PREVIAS, dir, 'index.html'));
  const prev = (path: string, label: string) => (ready ? ` <a href="${BASE}previa/${esc(dir)}/${path}" target="_blank" rel="noopener">${label}</a>` : ' <span class="muted">(prévia sendo montada, até 5 min)</span>');
  const pages = loadPages();
  const topics = loadTopics();
  const titleOf = (s?: string) => pages.find((p) => p.slug === s)?.title ?? s ?? '';
  const pageFor = (kind?: string) => pages.find((p) => p.status !== 'draft' && topics.find((t) => t.slug === p.slug)?.product_kinds.includes(kind ?? ''))?.slug;
  const query = /^(?:Tentativa \(rascunho\)|Página nova): (.+)$/.exec(b.subject)?.[1];
  const outcome = plainOutcome(b.steps);
  const review = reviewFrom(readBranch(b.branch), slug);
  // Por que cada mudança está aqui, em uma frase para o editor.
  const why = (it: ChangeItem): string => {
    if (it.id.startsWith('page:')) {
      const st = b.steps.find((x) => x.includes(it.slug ?? '¬'));
      if (/^resumo de/.test(st ?? '')) return 'A resposta curta não passava na trava (longa, técnica ou abrindo por norma/marca): o motor reescreveu o resumo para leigo, com as mesmas fontes.';
      if (/^re-auditoria/.test(st ?? '')) return 'A re-auditoria achou trechos que diziam mais do que as fontes e corrigiu só esses trechos.';
      if (/^enriquecimento/.test(st ?? '')) return 'Fontes novas foram lidas e a página foi reescrita com elas.';
      if (/Página nova no ar/.test(it.title)) return 'Página nova aprovada pela auditoria e pela revisão.';
      return 'Mudança de texto feita pelo motor neste ciclo.';
    }
    if (it.id === 'anchors') return 'Quando outra página do site usar estas palavras, elas viram link para este guia (o texto não muda).';
    if (it.id === 'search-links') return 'Botões de busca na Amazon com a nossa tag, embaixo dos exemplos à venda.';
    if (it.id === 'images') return 'Imagens novas geradas por IA (sem marca).';
    if (it.id.startsWith('product:')) return it.title.startsWith('Novo') ? 'Exemplo à venda novo para as páginas deste tipo.' : 'Exemplo retirado (motivo abaixo).';
    if (it.id === 'theme') return 'Mudança de visual pedida por você.';
    return '';
  };
  const item = (it: ChangeItem) => {
    const where = it.slug ? prev(`${esc(it.slug)}/`, 'ver na prévia') : it.kind && pageFor(it.kind) ? prev(`${esc(pageFor(it.kind)!)}/#exemplos`, 'ver na prévia') : it.id === 'theme' || it.id === 'home' ? prev('', 'ver na prévia') : '';
    const amazon = it.asin && it.title.startsWith('Novo exemplo') ? ` · <a href="https://www.amazon.com.br/dp/${esc(it.asin)}" target="_blank" rel="noopener">anúncio</a>` : '';
    const diffs = it.diffs?.length ? `<details><summary class="muted">ver antes → depois (${it.diffs.length})</summary>${it.diffs.slice(0, 12).map((d) => `<div class="diff"><span class="muted">${esc(d.where)}</span><del>${esc(d.before)}</del><ins>${esc(d.after)}</ins></div>`).join('')}</details>` : '';
    const thumbs = it.paths.filter((x) => /^site\/src\/assets\/generated\/[a-z0-9_-]+\.webp$/.test(x)).map((x) => `<a href="${BASE}imagem?ramo=${encodeURIComponent(b.branch)}&arquivo=${encodeURIComponent(x)}" target="_blank" rel="noopener"><img class="thumb" loading="lazy" alt="imagem nova" src="${BASE}imagem?ramo=${encodeURIComponent(b.branch)}&arquivo=${encodeURIComponent(x)}"></a>`).join('');
    const title = it.id.startsWith('page:') && !/Página nova/.test(it.title) ? `Texto: ${it.diffs?.length ?? 0} trecho(s) alterado(s)${it.detail?.includes('capa') ? ' + capa nova' : ''}` : it.title;
    return `<li><label><input type="checkbox" name="manter" value="${esc(it.id)}" checked> <strong>${esc(title)}</strong></label>${where}${amazon}<div class="why">${esc(why(it))}</div>${it.detail && !it.id.startsWith('page:') ? `<div class="muted">${esc(it.detail)}</div>` : ''}${thumbs ? `<div class="thumbs">${thumbs}<span class="muted">capa nova (IA): desmarque se não servir</span></div>` : ''}${diffs}</li>`;
  };
  // Agrupa por página: links e buscas que tocam uma página só vão para o grupo dela.
  const target = (it: ChangeItem) => it.slug ?? (it.detail && /^([a-z0-9-]+):/.test(it.detail) && !it.detail.includes(' · ') ? /^([a-z0-9-]+):/.exec(it.detail)![1] : undefined) ?? (it.kind ? pageFor(it.kind) : undefined) ?? '';
  const groups = new Map<string, ChangeItem[]>();
  for (const it of items) groups.set(target(it), [...(groups.get(target(it)) ?? []), it]);
  const groupHtml = [...groups].map(([s, its]) => `<div class="pg"><p class="pg-title">${s ? `<strong>${esc(titleOf(s))}</strong>${prev(`${esc(s)}/`, 'abrir prévia')}` : '<strong>Site todo</strong>'}</p><ul class="changes">${its.map(item).join('')}</ul></div>`).join('');
  const draftNew = query && !items.some((i) => i.id === `page:${slug}`);
  return `<div class="result" data-pending>
<p class="result-head"><strong>Resultado do ciclo de ${esc(fmt(b.when))}</strong>${b.cost !== null ? ` <span class="muted">· custo ~${b.cost.toFixed(1)} créditos</span>` : ''}</p>
${items.length ? `<form method="post" action="acao" onsubmit="return confirm('Aplicar só os itens marcados? Os desmarcados não entram (produto recusado não volta).')"><input type="hidden" name="acao" value="mesclar"><input type="hidden" name="ramo" value="${esc(b.branch)}">${failedNote(slug)}
<div class="block"><p class="block-title">1. Mudanças no site para você decidir (${items.length})</p><p class="muted">Desmarque o que não quiser. O resto entra no site depois dos testes.</p>${groupHtml}</div>
${forceBox(slug)}<button class="ok">Aplicar marcados</button></form>` : '<p class="muted">Nada muda no site: o aprendizado entra sozinho em até 5 min, depois dos testes e do build.</p>'}
${!query ? adjustDiffsHtml(readBranch(b.branch), slug) : ''}
${query ? `<div class="block"><p class="block-title">${items.length ? '2. ' : ''}Página nova tentada: "${esc(query)}"</p><p>${esc(outcome ?? b.subject)}${draftNew ? '. Ela entra como rascunho junto com este resultado (não vai ao ar) e passa a aparecer em "Páginas: seu veredito", onde você pode pedir ajuste ou aprovar.' : ''}</p>
${suggestionHtml(review)}${adjustDiffsHtml(readBranch(b.branch), slug)}${review?.review.missing.length ? `<form method="post" action="acao" class="verdict adjust" onsubmit="return confirm('Pesquisar fontes para o que faltou e reescrever o rascunho? ~10 a 20 créditos; você decide depois.')"><input type="hidden" name="acao" value="ajustar"><input type="hidden" name="ramo" value="${esc(b.branch)}"><input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="pesquisar" value="1"><input type="hidden" name="pedido" value="${esc(('Complete o que a revisão disse que faltou, só com o que as fontes sustentarem: ' + review.review.missing.join(' | ')).slice(0, 600))}"><button>Completar o que faltou neste rascunho (com pesquisa)</button></form>` : ''}${adjustForm(b.branch, slug)}</div>` : ''}
<details><summary class="muted">o que o motor também guardou (não aparece no site)</summary><p class="muted">${esc(learning.join('; ') || 'registros do ciclo')}.</p></details>
<details><summary class="muted">detalhes técnicos</summary><ul class="muted">${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><a class="muted" href="${REPO_URL}/compare/main...${esc(b.branch)}" target="_blank" rel="noopener">diferenças no GitHub</a></details>
<div class="actions">${form('descartar', { ramo: b.branch }, 'Descartar tudo', 'bad', 'Descartar este resultado inteiro, inclusive o aprendizado? A pauta volta para a fila.')}</div>
</div>`;
}

// Quadro de decisões: um cartão por assunto, sempre com os mesmos campos (assunto, tipo, situação, sugestão,
// por quê, imagem, produtos, correção pronta, prévia) e o botão da sugestão em destaque. Dados e ações são
// os mesmos do formato antigo (mesclar, veredito, ajustar, descartar); só a apresentação muda.
// Nota de leitor (0 a 4, as 4 perguntas do editor) da versão atual e, se ela veio de uma correção, a de antes
// (22/10, editor: "ótima ideia mostrar a nota da página no quadro"). Lê a revisão mais recente da página.
function scoreHtml(read: (path: string) => string | null, slug: string): string {
  try {
    const page = JSON.parse(read(`data/pages/${slug}.json`) ?? 'null');
    if (!page) return '';
    const runs = String(page.provenance.run_id).split('+').map((x: string) => x.replace(/^[a-z]+:/, '')).reverse();
    for (const r of runs) {
      const pj = JSON.parse(read(`data/runs/${r}/page.json`) ?? 'null');
      if (!pj?.review) continue;
      const n = (x: number) => String(x).replace('.', ',');
      const now = readerScore(pj.review);
      const was = pj.review_before ? readerScore(pj.review_before) : null;
      const bar = `<span class="score s${Math.floor(now)}">${n(now)} de 4</span>`;
      return was === null ? bar : `${bar} <span class="muted">${now > was ? `subiu de ${n(was)}` : now < was ? `caiu de ${n(was)}` : `igual à versão anterior (${n(was)})`} com a última correção</span>`;
    }
  } catch {
    /* sem revisão registrada */
  }
  return '';
}

export function boardHtml(pages: ReturnType<typeof loadPages>, branches: ReturnType<typeof pendingBranches>): string {
  const cards: { order: number; html: string }[] = [];
  const titleOf = (s: string) => pages.find((p) => p.slug === s)?.title ?? s;
  const row = (k: string, v: string) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : '');
  const sugBadge = (sg: Suggestion) => `<span class="b ${sg === 'nada' ? 'neutral' : sg === 'recusar' ? 'bad' : sg === 'corrigir' ? 'warn' : 'ok'}">${esc(SUGGESTION_LABEL[sg])}</span>`;
  const correctionForm = (ramo: string, slug: string, text: string, open: boolean) =>
    `<details class="dfix"${open ? ' open' : ''}><summary><strong>Pedir correção</strong> <span class="muted">(texto pronto; edite à vontade)</span></summary><form method="post" action="acao"><input type="hidden" name="acao" value="ajustar"><input type="hidden" name="ramo" value="${esc(ramo)}"><input type="hidden" name="slug" value="${esc(slug)}"><textarea name="pedido" required minlength="5" maxlength="600" rows="4" placeholder="o que mudar (ex.: mova a tabela 'Medidas por tamanho' para o Como decidir)">${esc(text)}</textarea><label class="muted"><input type="checkbox" name="pesquisar" value="1"> pode pesquisar fontes novas (mais caro)</label> <button>Pedir correção</button></form></details>`;

  for (const b of branches) {
    const dir = b.branch.replace(/^pagina\//, '');
    let slug = dir.replace(/-\d{8}-\d{4}$/, '');
    let items: ChangeItem[] = [];
    try { items = gitChanges(`origin/${b.branch}`).summary.items; } catch { /* sem leitura: cartão informativo */ }
    // Resultado de um pedido em texto livre (ramo pagina/pedido-*): a página é a que o pedido mudou.
    if (slug === 'pedido') slug = items.find((i) => i.id.startsWith('page:'))?.slug ?? items.flatMap((i) => i.paths).map((x) => /generated\/pagina-([a-z0-9-]+)\.webp$/.exec(x)?.[1]).find(Boolean) ?? 'pedido';
    const query = /^(?:Tentativa \(rascunho\)|Página nova): (.+)$/.exec(b.subject)?.[1];
    const outcome = plainOutcome(b.steps);
    const rv = reviewFrom(readBranch(b.branch), slug)?.review ?? null;
    const failed = !!failedAdjust(jobs, slug);
    const info = classifyBranch({ slug, items, query, outcome, steps: b.steps, review: rv, failedAdjust: failed, rules: rulesFromNotes(loadTopics().find((t) => t.slug === slug)?.editorial_notes ?? []) });
    // Aprendizado sem pauta (só registros) não pede nada; pauta tentada ganha cartão informativo, qualquer
    // que seja o desfecho (22/10: o pillow top travou na auditoria e não aparecia no quadro).
    if (info.kind === 'pauta-tentada' && !query) continue;
    const ready = existsSync(join(PREVIAS, dir, 'index.html'));
    const prevLink = (path: string, label: string) => (ready ? `<a href="${BASE}previa/${esc(dir)}/${path}" target="_blank" rel="noopener">${label}</a>` : '<span class="muted">sendo montada (até 5 min)</span>');
    const visual = (it: ChangeItem) => it.id === 'images' || it.id.startsWith('product:') || it.id === 'theme' || it.id === 'home';
    const thumbsOf = (it: ChangeItem) => it.paths.filter((x) => /^site\/src\/assets\/generated\/[a-z0-9_-]+\.webp$/.test(x)).map((x) => `<a href="${BASE}imagem?ramo=${encodeURIComponent(b.branch)}&arquivo=${encodeURIComponent(x)}" target="_blank" rel="noopener"><img class="thumb" loading="lazy" alt="imagem nova" src="${BASE}imagem?ramo=${encodeURIComponent(b.branch)}&arquivo=${encodeURIComponent(x)}"></a>`).join('');
    const check = (it: ChangeItem, label: string) => `<label class="acc"><input type="checkbox" name="manter" value="${esc(it.id)}" checked> ${label}</label>`;
    const imgs = items.filter((i) => i.id === 'images').map((it) => `<div class="thumbs">${thumbsOf(it)}</div>${check(it, 'aceitar imagem')}`).join('');
    const prods = items.filter((i) => i.id.startsWith('product:')).map((it) => `<div>${esc(it.title)}${it.asin ? ` · <a href="https://www.amazon.com.br/dp/${esc(it.asin)}" target="_blank" rel="noopener">anúncio</a>` : ''} ${check(it, 'aceitar')}</div>`).join('');
    const others = items.filter((i) => !visual(i)).map((it) => `<input type="hidden" name="manter" value="${esc(it.id)}">`).join('');
    const pageItem = items.find((i) => i.id === `page:${slug}`);
    const diffsHtml = pageItem?.diffs?.length ? `<details><summary class="muted">antes → depois (${pageItem.diffs.length})</summary>${pageItem.diffs.slice(0, 12).map((d) => `<div class="diff"><span class="muted">${esc(d.where)}</span><del>${esc(d.before)}</del><ins>${esc(d.after)}</ins></div>`).join('')}</details>` : '';
    // Manutenção: diz de qual página é a capa ou o produto, em vez de "Site todo".
    const coverOf = items.flatMap((i) => i.paths).map((x) => /generated\/pagina-([a-z0-9-]+)\.webp$/.exec(x)?.[1]).find((x) => x && pages.some((p) => p.slug === x));
    // 23/10: ciclo de "cadeira para obeso" que parou antes de virar página, mas trouxe a capa do pillow top,
    // aparecia como "cadeira para obeso" com a imagem do pillow top. Manutenção leva o nome do que muda.
    const maintSubject = items.find((i) => i.id === 'niche')?.title ?? (coverOf ? `Capa nova: ${titleOf(coverOf)}` : items.some((i) => i.id.startsWith('product:')) ? 'Exemplos à venda' : 'Site todo');
    const subject = info.kind === 'manutencao' ? maintSubject : (query ?? (slug && pages.some((p) => p.slug === slug) ? titleOf(slug) : maintSubject));
    const alsoTried = info.kind === 'manutencao' && query ? `A pauta "${query}" também foi tentada neste ciclo: ${outcome ?? 'não virou página'}. Nada dela muda o site.` : '';
    const prevPath = pageItem || (query && info.kind !== 'manutencao') ? `${esc(slug)}/` : coverOf ? `${esc(coverOf)}/` : '';
    const primary = info.kind === 'pagina-nova' ? (info.suggestion === 'publicar' ? 'Publicar' : 'Publicar assim mesmo') : info.suggestion === 'aplicar' ? 'Aplicar' : 'Aplicar assim mesmo';
    const actionForm = items.length
      ? `<form method="post" action="acao" onsubmit="return confirm('${info.kind === 'pagina-nova' ? 'Publicar esta página' : 'Aplicar estas mudanças'} com os itens marcados? Roda testes e build antes de ir ao site.')"><input type="hidden" name="acao" value="mesclar"><input type="hidden" name="ramo" value="${esc(b.branch)}">${others}
<dl class="dl">${row('Situação', esc(info.situation))}${row('Nota de leitor', pageItem || query ? scoreHtml(readBranch(b.branch), slug) : '')}${row('Sugestão do motor', sugBadge(info.suggestion))}${row('Por quê', esc(info.why))}${row('Imagem', imgs)}${row('Produtos novos', prods)}${row('Prévia', prevLink(prevPath, 'abrir prévia'))}${row('Também neste ciclo', esc(alsoTried))}</dl>
${forceBox(slug)}<div class="dactions"><button class="${info.suggestion === 'publicar' || info.suggestion === 'aplicar' ? 'ok big' : ''}">${primary}</button></div></form>`
      : `<dl class="dl">${row('Situação', esc(info.situation))}${row('Sugestão do motor', sugBadge(info.suggestion))}${row(/Adiada/.test(info.situation) ? 'Falta' : 'Por quê', esc(info.why))}</dl>`;
    // O que cada escolha faz, escrito no próprio cartão (22/10: o editor não sabia a diferença entre tirar da
    // fila, não fazer nada e descartar).
    const next = /rascunho/.test(info.situation)
      ? 'em até 5 minutos o rascunho aparece num cartão para você aprovar, corrigir ou recusar'
      : /Adiada/.test(info.situation)
        ? 'o motor tenta de novo em 3 dias, buscando o que falta'
        : 'o motor tenta de novo quando a pauta for a da vez, partindo do que já guardou';
    const extra = info.kind === 'pauta-tentada' && query
      ? `<p class="dnext"><strong>Não fazer nada (recomendado):</strong> ${next}.</p><div class="dactions">${form('fila-remover', { consulta: query }, 'Tirar da fila', '', `Tirar "${query}" da fila? O motor não tenta mais este assunto; o que este ciclo já guardou continua.`)} <span class="muted">só se você não quer mais este assunto no site.</span></div>`
      : '';
    const html = `<div class="dcard sg-${info.suggestion}"${info.suggestion === 'nada' ? '' : ' data-pending'}>
<div class="dhead"><span class="tag">${esc(KIND_LABEL[info.kind])}</span> <strong>${esc(subject)}</strong> <span class="muted">· ciclo de ${esc(fmt(b.when))}${b.cost !== null ? ` · ~${b.cost.toFixed(1)} créditos` : ''}</span></div>
${actionForm}${diffsHtml}${adjustDiffsHtml(readBranch(b.branch), slug)}
${info.kind !== 'pauta-tentada' && info.kind !== 'manutencao' ? correctionForm(b.branch, slug, info.correction, info.suggestion === 'corrigir') : ''}${extra}
${info.kind === 'pauta-tentada' ? '' : info.kind === 'ajuste-no-ar'
  ? `<div class="dfoot">${form('descartar', { ramo: b.branch }, 'Descartar este ajuste', 'link', 'Descartar este ajuste? A página no ar não muda; as fontes, evidências e lacunas que ele achou ficam guardadas.')} <span class="muted">(a página no ar fica como está; o que o motor aprendeu fica guardado)</span></div>`
  : `<div class="dfoot"><span class="muted">raramente necessário:</span> ${form('descartar', { ramo: b.branch }, 'Descartar este resultado', 'link', 'Descartar apaga tudo o que este ciclo produziu (fontes, evidências, página) e a pauta é refeita do zero, gastando créditos de novo. Continuar?')} <span class="muted">(apaga tudo deste ciclo e refaz a pauta do zero)</span></div>`}
</div>`;
    cards.push({ order: SUGGESTION_ORDER.indexOf(info.suggestion), html });
  }

  // Rascunhos no main esperando veredito (página nova reprovada pela revisão, ajuste em rascunho).
  const verdicts = loadVerdicts();
  const judged = (p: (typeof pages)[number]) => verdicts.some((v) => v.slug === p.slug && v.run_id === p.provenance.run_id);
  for (const p of pages.filter((x) => x.status === 'draft' && !judged(x))) {
    const rv = reviewFrom(readMain, p.slug)?.review ?? null;
    const info = classifyDraft({ review: rv, failedAdjust: !!failedAdjust(jobs, p.slug), rules: rulesFromNotes(loadTopics().find((t) => t.slug === p.slug)?.editorial_notes ?? []) });
    const approve = `<form method="post" action="acao" class="inline"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}"><input type="hidden" name="veredito" value="approve"><input type="hidden" name="motivo" value="Aprovado no quadro de decisões">${forceBox(p.slug)}<button class="${info.suggestion === 'aprovar' ? 'ok big' : 'ok'}">Aprovar e publicar</button></form>`;
    const reject = `<details class="dfix"${info.suggestion === 'recusar' ? ' open' : ''}><summary><strong>Recusar</strong> <span class="muted">(o motivo vira instrução para a nova tentativa)</span></summary><form method="post" action="acao"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}"><input type="hidden" name="veredito" value="reject"><textarea name="motivo" required minlength="3" maxlength="400" rows="3">${esc(info.correction.replace(/^(Corrija, só com o que as fontes sustentarem|Reescreva a resposta curta e o Como decidir com estas regras, que as fontes já sustentam): /, '').slice(0, 400) || 'fraca para o leitor')}</textarea><button class="bad">Recusar</button></form></details>`;
    cards.push({
      order: SUGGESTION_ORDER.indexOf(info.suggestion),
      html: `<div class="dcard sg-${info.suggestion}" data-pending>
<div class="dhead"><span class="tag">${esc(KIND_LABEL.rascunho)}</span> <strong>${esc(p.title)}</strong></div>
<dl class="dl">${row('Situação', esc(info.situation))}${row('Nota de leitor', scoreHtml(readMain, p.slug))}${row('Sugestão do motor', sugBadge(info.suggestion))}${row('Por quê', esc(info.why))}${row('Prévia', `<a href="${PREVIEW}/${esc(p.slug)}/" target="_blank" rel="noopener">abrir prévia</a>`)}</dl>
${failedNote(p.slug)}<div class="dactions">${approve}</div>${adjustDiffsHtml(readMain, p.slug)}
${correctionForm('main', p.slug, info.correction, info.suggestion === 'corrigir')}${reject}
</div>`,
    });
  }

  cards.sort((a, b) => a.order - b.order);
  const need = cards.filter((c) => c.order < SUGGESTION_ORDER.indexOf('nada')).length;
  return `<h2>Quadro de decisões ${need ? `<span class="b neutral">${need} pedem você</span>` : ''}</h2>
${cards.length ? cards.map((c) => c.html).join('') : '<p class="muted">Nada pedindo decisão agora. Resultados que só trazem aprendizado entram sozinhos em até 5 minutos.</p>'}
<p class="muted">Ao pedir correção: para mover uma tabela, cite o título dela. A última linha da resposta diz o que não foi feito por falta de fonte.</p>`;
}

// Catálogo de exemplos à venda + produto escolhido pelo editor (link colado; a Amazon bloqueia a leitura
// automática dos anúncios). Escolha do editor sai do site se passar de EDITOR_PICK_MAX_AGE_DAYS sem reconferir.
function productsHtml(): string {
  const kinds = loadNiche().product_kinds.filter((k) => k.id !== 'outro');
  const label = new Map(kinds.map((k) => [k.id, k.label]));
  const today = Date.now();
  const rows = loadProducts().map((p) => {
    const age = p.evidence === 'editor' ? Math.floor((today - Date.parse(p.editor!.checked_at)) / 86_400_000) : null;
    const how = p.evidence === 'editor' ? `escolha sua, conferida há ${age} dia(s)${age! > 30 ? ` <span class="b bad">reconferir</span>` : ''}` : p.evidence === 'manufacturer' ? 'motor: ficha do fabricante + anúncio' : 'motor: só anúncio';
    return `<tr><td><a href="https://www.amazon.com.br/dp/${esc(p.asin)}" target="_blank" rel="noopener">${esc(p.label)}</a></td><td class="muted">${esc(label.get(p.kind) ?? p.kind)}</td><td class="muted">${how}</td><td class="actions">${p.evidence === 'editor' ? form('produto-reconferir', { asin: p.asin }, 'Reconferi', 'ok') : ''}${form('produto-remover', { asin: p.asin }, 'Remover', 'bad', `Tirar "${p.label}" do site? Ele não volta pela busca automática.`)}</td></tr>`;
  });
  return `${rows.length ? `<div class="tw"><table><thead><tr><th>Produto</th><th>Tipo</th><th>Origem</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="muted">Nenhum produto no catálogo.</p>'}
<form method="post" action="acao" class="verdict" style="margin-top:10px"><input type="hidden" name="acao" value="produto-adicionar">
<input name="link" required maxlength="500" placeholder="link do anúncio na Amazon" style="min-width:240px">
<select name="tipo">${kinds.map((k) => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join('')}</select>
<input name="marca" required minlength="2" maxlength="40" placeholder="marca (ex.: Cavaletti)">
<input name="nome" required minlength="5" maxlength="80" placeholder="nome com a marca (ex.: Cavaletti Air)">
<button class="ok">Adicionar</button></form>
<p class="muted">Aparece com a imagem do tipo (gerada por IA) em todas as páginas desse tipo, com "conferido pelo editor em". Reconfira em até 45 dias; depois disso o cartão sai do site sozinho até você reconferir.</p>`;
}

// Vereditos: só pede decisão do que precisa dela. Rascunho cuja versão atual ainda não foi julgada fica
// em destaque; recusado aguarda o motor; página no ar fica recolhida (com opção de despublicar).
function verdictsHtml(pages: ReturnType<typeof loadPages>): string {
  const verdicts = loadVerdicts();
  const lastFor = (p: (typeof pages)[number]) => verdicts.filter((v) => v.slug === p.slug && v.run_id === p.provenance.run_id).at(-1);
  const editLink = (p: (typeof pages)[number]) => `<a href="${BASE}editar/${esc(p.slug)}">Editar texto</a>`;
  const box = (p: (typeof pages)[number], approve: boolean, label: string) => `<form method="post" action="acao" class="verdict"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}"><input name="motivo" required minlength="3" maxlength="400" placeholder="motivo (obrigatório)">${approve ? `${forceBox(p.slug)}<button name="veredito" value="approve" class="ok">Aprovar</button>` : ''}<button name="veredito" value="reject" class="bad">${label}</button></form>`;
  const link = (p: (typeof pages)[number]) => `<a href="${PREVIEW}/${esc(p.slug)}/" target="_blank" rel="noopener">${esc(p.title)}</a>`;
  const drafts = pages.filter((p) => p.status === 'draft');
  const waiting = drafts.filter((p) => !lastFor(p));
  const rejected = drafts.filter((p) => lastFor(p)?.verdict === 'reject');
  const live = pages.filter((p) => p.status !== 'draft');
  return `<h2>Páginas: seu veredito ${waiting.length ? `<span class="b neutral">${waiting.length} aguardando</span>` : ''}</h2>
${waiting.length ? `<p class="muted">Leia na <a href="${PREVIEW}/" target="_blank" rel="noopener">prévia</a>. Aprovar publica; recusar volta ao motor com o motivo como instrução. Cada veredito calibra a revisão automática.</p>
<p class="muted">Ao pedir ajuste: para mover uma tabela, cite o título dela ("mova a tabela 'Medidas por tamanho' para o Como decidir"), sem colar o conteúdo. A última linha da resposta diz o que não foi feito por falta de fonte. Motivo concreto na recusa vira lição para todas as páginas.</p>
<div class="tw"><table><tbody>${waiting.map((p) => `<tr data-pending><td>${link(p)}${failedNote(p.slug)}${suggestionHtml(reviewFrom(readMain, p.slug))}${adjustDiffsHtml(readMain, p.slug)}</td><td>${box(p, true, 'Recusar')}${adjustForm('main', p.slug)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nada aguardando o seu veredito.</p>'}
${rejected.length ? `<p class="muted" style="margin-top:10px">Recusadas, o motor vai tentar de novo: ${rejected.map((p) => `${link(p)} <span class="muted">("${esc(lastFor(p)!.reason.slice(0, 80))}")</span>`).join(' · ')}</p>` : ''}
<details style="margin-top:10px"><summary><strong>${live.length} página(s) no ar</strong> <span class="muted">(despublicar só se achar um problema)</span></summary><div class="tw"><table><tbody>${live.map((p) => `<tr><td>${link(p)}<br>${editLink(p)}</td><td class="muted">atualizada ${esc(p.updated_at)}</td><td>${box(p, false, 'Despublicar')}${adjustForm('main', p.slug)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

// Páginas no ar numa aba própria (23/10, editor: "no futuro teremos 200+ páginas, já podemos deixar a
// estrutura pronta"): uma linha por página com nota de leitor, visitas e cliques na Amazon (30 dias, contador
// próprio), Google (impressões e posição) e as ações. Busca, filtro de categoria e ordenação no navegador.
const SITE = process.env.BEM_SITE_URL ?? 'https://bemapoiado.com';
export function livePagesHtml(pages: ReturnType<typeof loadPages>): string {
  const live = pages.filter((p) => p.status !== 'draft');
  if (!live.length) return '<p class="muted">Nenhuma página no ar ainda.</p>';
  const niche = loadNiche();
  const topics = new Map(loadTopics().map((t) => [t.slug, t]));
  const catOf = (slug: string) => niche.categories.find((c) => c.kinds.some((k) => topics.get(slug)?.product_kinds.includes(k)));
  const traffic = new Map(trafficSummary(30).pages.map((t) => [t.path.replace(/^\/|\/$/g, ''), t]));
  const snap = latestSnapshot();
  const google = snap ? pageStats(snap) : new Map();
  // Nota do juiz atual (data/judge-rescore.json) vale mais que a da revisão da época em que a página foi escrita.
  const rf = join(DATA, 'judge-rescore.json');
  // Só quando é da mesma versão da página: depois de um ajuste aplicado vale a revisão da versão nova (23/10: o
  // como escolher colchão subiu para 2,5 e a aba seguia mostrando 1,5, do juiz de 22/10).
  const rescore: Record<string, { metrics?: Parameters<typeof readerScore>[0]; page_updated_at?: string }> = existsSync(rf) ? (JSON.parse(readFileSync(rf, 'utf8')).pages ?? {}) : {};
  const rows = live.map((p) => {
    const rs = rescore[p.slug];
    const rv = (rs?.page_updated_at === p.updated_at ? rs.metrics : undefined) ?? (reviewFrom(readMain, p.slug)?.review as Parameters<typeof readerScore>[0] | undefined);
    const score = rv ? readerScore(rv) : null;
    const t = traffic.get(p.slug);
    const g = google.get(p.slug);
    const cat = catOf(p.slug);
    const ask = (texto: string, label: string, confirm: string) => form('pedido', { texto }, label, '', confirm);
    const actions = `<details><summary>ações</summary><div class="pacts">
<a href="${BASE}editar/${esc(p.slug)}">Editar texto</a>
${adjustForm('main', p.slug)}
${ask(`Busque exemplos à venda na Amazon para a página ${p.slug}.`, 'Buscar exemplos à venda', 'Buscar exemplos à venda para esta página? Gasta poucos créditos; o resultado vai para o quadro.')}
${ask(`Gere uma capa nova para a página ${p.slug}, mostrando o tema do guia.`, 'Gerar capa nova', 'Gerar uma capa nova (~5 créditos)? Ela vai para o quadro para você aceitar.')}
<form method="post" action="acao" class="verdict" onsubmit="return confirm('Tirar esta página do ar?')"><input type="hidden" name="acao" value="veredito"><input type="hidden" name="slug" value="${esc(p.slug)}"><input type="hidden" name="veredito" value="reject"><input name="motivo" required minlength="3" maxlength="400" placeholder="motivo para despublicar"><button class="bad">Despublicar</button></form>
</div></details>`;
    const num = (v: number | null | undefined, txt?: string) => `<td class="num" data-v="${v ?? -1}">${v === null || v === undefined ? '<span class="muted">–</span>' : (txt ?? v)}</td>`;
    return `<tr data-cat="${esc(cat?.id ?? '')}" data-q="${esc(`${p.title} ${p.slug}`.toLowerCase())}"><td data-v="${esc(p.title.toLowerCase())}"><a href="${SITE}/${esc(p.slug)}/" target="_blank" rel="noopener">${esc(p.title)}</a><br><span class="muted">${esc(cat?.label ?? 'sem categoria')}</span></td>${num(score, score === null ? undefined : `<span class="score s${Math.floor(score)}">${String(score).replace('.', ',')}</span>`)}${num(t?.views ?? 0)}${num(t?.clicks ?? 0)}${num(g ? g.impressions : null)}${num(g ? Math.round(g.position * 10) / 10 : null, g ? g.position.toFixed(1).replace('.', ',') : undefined)}<td data-v="${esc(p.updated_at)}" class="muted">${esc(p.updated_at.slice(0, 10).split('-').reverse().join('/'))}</td><td>${actions}</td></tr>`;
  });
  const cats = niche.categories.filter((c) => live.some((p) => catOf(p.slug)?.id === c.id));
  return `<p class="muted">${live.length} página(s) no ar. Visitas e cliques na Amazon: últimos 30 dias, pelo contador do site. Google: último retrato do Search Console${snap ? ` (${esc(snap.start)} a ${esc(snap.end)})` : ' (ainda sem dados)'}. Clique no título de uma coluna para ordenar.</p>
<div class="verdict" style="margin-bottom:8px"><input id="pg-q" placeholder="buscar página" style="min-width:200px"><select id="pg-cat"><option value="">todas as categorias</option>${cats.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></div>
<div class="tw"><table id="pg-live"><thead><tr><th data-s="0">Página</th><th data-s="1" class="num">Nota</th><th data-s="2" class="num">Visitas</th><th data-s="3" class="num">Cliques Amazon</th><th data-s="4" class="num">Impressões Google</th><th data-s="5" class="num">Posição</th><th data-s="6">Atualizada</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<script>(function () {
  var t = document.getElementById('pg-live'); if (!t) return;
  var q = document.getElementById('pg-q'), c = document.getElementById('pg-cat');
  function filter() { var s = (q.value || '').toLowerCase(); t.tBodies[0].querySelectorAll('tr').forEach(function (r) { r.hidden = (s && r.dataset.q.indexOf(s) < 0) || (c.value && r.dataset.cat !== c.value); }); }
  q.oninput = filter; c.onchange = filter;
  t.querySelectorAll('th[data-s]').forEach(function (th) { th.style.cursor = 'pointer'; th.onclick = function () {
    var i = +th.dataset.s, dir = th.dataset.d === 'desc' ? 'asc' : 'desc'; th.dataset.d = dir;
    var rows = Array.prototype.slice.call(t.tBodies[0].rows);
    rows.sort(function (a, b) { var x = a.cells[i].dataset.v, y = b.cells[i].dataset.v; var nx = parseFloat(x), ny = parseFloat(y);
      var r = isNaN(nx) || isNaN(ny) || i === 0 || i === 6 ? x.localeCompare(y) : nx - ny; return dir === 'desc' ? -r : r; });
    rows.forEach(function (r) { t.tBodies[0].appendChild(r); });
  }; });
})();</script>`;
}

// Último aviso aos buscadores (sync, a cada 5 min, quando o sitemap do site no ar muda).
function announceHtml(): string {
  const a = loadAnnounce()?.last;
  return `<p class="muted"><strong>Aviso de página nova:</strong> ${a ? `${esc(fmt(a.at))}: IndexNow (Bing e buscas por IA) ${esc(a.indexnow)}; Google ${esc(a.gsc)}.` : 'a cada página publicada ou atualizada, o motor avisa o IndexNow (Bing e buscas por IA) e reenvia o sitemap ao Google; ainda não houve aviso.'}</p>`;
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
// O aviso da última ação vem no endereço (?msg=): mostra uma vez e limpa, para a atualização automática
// não repetir o aviso para sempre.
if (location.search) history.replaceState(null, '', location.pathname);
(function () {
  var MAP = [['Quadro de decisões','decisoes'],['Páginas no ar','paginas'],['Pedir ao motor','decisoes'],['Esperando sua decisão','decisoes'],['Páginas: seu veredito','decisoes'],['Fila de pautas','conteudo'],['Produtos à venda','conteudo'],['Domínios novos','conteudo'],
    ['Visitas','desempenho'],['Google Search Console','desempenho'],['Qualidade do motor','desempenho'],['Créditos de IA','desempenho'],
    ['Saldo de créditos','config'],['Senha do painel','config']];
  var NAMES = { decisoes: 'Decisões', paginas: 'Páginas', conteudo: 'Conteúdo', desempenho: 'Desempenho', motor: 'Motor', config: 'Configurações' };
  var main = document.querySelector('main'); if (!main) return;
  var grid = main.querySelector('.grid'); if (!grid) return;
  var panes = {}; var cur = null;
  Object.keys(NAMES).forEach(function (k) { var d = document.createElement('div'); d.className = 'pane'; d.dataset.tab = k; panes[k] = d; });
  // Avisos antes do 1º título (ciclo ao vivo, última ação) ficam acima das abas; o resto vai para a aba
  // do seu título (antes, todo aviso ficava fora das abas e as respostas dos pedidos caíam no fim da página).
  var after = false; var top = grid;
  Array.prototype.slice.call(main.children).forEach(function (n) {
    if (n === grid) { after = true; return; }
    if (!after) return;
    if (n.tagName === 'H2') { var t = n.textContent || ''; cur = 'motor'; MAP.forEach(function (m) { if (t.indexOf(m[0]) === 0) cur = m[1]; }); }
    if (cur) panes[cur].appendChild(n); else top = n;
  });
  var bar = document.createElement('nav'); bar.className = 'tabs';
  var pending = panes.decisoes.querySelectorAll('[data-pending]').length;
  Object.keys(NAMES).forEach(function (k) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = NAMES[k]; b.dataset.tab = k;
    if (k === 'decisoes' && pending) { var s = document.createElement('span'); s.className = 'count'; s.textContent = pending; b.appendChild(s); }
    b.onclick = function () { show(k); }; bar.appendChild(b);
  });
  top.after(bar); var holder = bar; Object.keys(panes).forEach(function (k) { holder.after(panes[k]); holder = panes[k]; });
  function show(k) { Object.keys(panes).forEach(function (x) { panes[x].hidden = x !== k; }); bar.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === k); }); try { localStorage.setItem('painel-aba', k); } catch (e) {} }
  var saved = null; try { saved = localStorage.getItem('painel-aba'); } catch (e) {}
  // Decisões pendentes abrem a aba Decisões só na primeira visita da sessão; depois, fica onde o editor estava.
  var first = true; try { first = !sessionStorage.getItem('painel-visto'); sessionStorage.setItem('painel-visto', '1'); } catch (e) {}
  show(pending && first ? 'decisoes' : saved && panes[saved] ? saved : 'decisoes');
})();
</script>`;

// Impressão digital do que o painel mostra e muda sozinho: versão do código, ações (fila, rodando, fim),
// ciclo ao vivo e resultados pendentes. O navegador consulta /estado e só recarrega quando ela muda.
function panelVersion(): string {
  let cycle = '';
  try {
    const c = JSON.parse(readFileSync(join(STATE, 'cycle-live.json'), 'utf8'));
    cycle = `${c.state}|${c.updated}|${(c.steps ?? []).length}`;
  } catch { /* sem ciclo */ }
  const j = jobs.slice(0, 12).map((x) => `${x.id}:${x.queued ? 'q' : x.ended ? x.code : 'r'}`).join(',');
  const b = pendingBranches().map((x) => `${x.branch}@${x.when}`).join(',');
  return createHash('sha1').update(`${head()}|${cycle}|${j}|${b}`).digest('hex').slice(0, 16);
}

// Atualização automática que não apaga o que o editor está escrevendo (21/10: um pedido de ajuste se perdeu
// quando a página recarregou). Recarrega só sem campo de texto em foco ou preenchido; o rascunho de cada
// campo fica no navegador (localStorage) e volta depois de recarregar; sai ao enviar o formulário.
const draftsJs = (secs: number, version: string) => `<script>
(function () {
  var fields = Array.prototype.slice.call(document.querySelectorAll('textarea, input[type=text], input:not([type])'));
  function key(el) { var f = el.form; var parts = ['rascunho']; if (f) Array.prototype.slice.call(f.querySelectorAll('input[type=hidden]')).forEach(function (h) { parts.push(h.name + '=' + h.value); }); parts.push(el.name || ''); return parts.join('|'); }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  fields.forEach(function (el) {
    var k = key(el); var saved = get(k);
    if (saved && !el.value) { el.value = saved; el.classList.add('restored'); }
    el.addEventListener('input', function () { set(k, el.value); });
    if (el.form) el.form.addEventListener('submit', function () { set(k, ''); });
  });
  // Volta para onde o editor estava (aba e rolagem) depois de recarregar.
  try { var y = sessionStorage.getItem('painel-y'); if (y !== null) { sessionStorage.removeItem('painel-y'); window.scrollTo(0, +y); } } catch (e) {}
  function busy() { var a = document.activeElement; if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT')) return true; if (document.querySelector('details[open] pre')) return true; return fields.some(function (el) { return el.value && el.value.trim(); }); }
  var current = '${version}';
  // Consulta leve em segundo plano; recarrega só quando algo mudou e o editor não está escrevendo.
  setInterval(function () {
    if (document.hidden) return;
    fetch('estado', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.v === current || busy()) return;
      try { sessionStorage.setItem('painel-y', String(window.scrollY)); } catch (e) {}
      location.reload();
    }).catch(function () {});
  }, ${secs} * 1000);
})();
</script>`;

// Pedir ajuste antes de decidir: o texto muda no próprio resultado (página no ar: num resultado novo, que volta para aprovação), com as mesmas fontes e
// auditoria; a prévia se refaz. Só para resultado que tem página.
function adjustForm(ramo: string, slug: string): string {
  const hasPage = ramo === 'main' || readBranch(ramo)(`data/pages/${slug}.json`) !== null;
  if (!hasPage) return '';
  return `<form method="post" action="acao" class="verdict adjust"><input type="hidden" name="acao" value="ajustar"><input type="hidden" name="ramo" value="${esc(ramo)}"><input type="hidden" name="slug" value="${esc(slug)}"><input name="pedido" required minlength="5" maxlength="600" placeholder="pedir ajuste (ex.: resposta curta mais direta)" title="Para mover uma tabela, cite o título dela: mova a tabela &quot;Medidas por tamanho&quot; para o Como decidir. A resposta mostra no fim o que não foi feito por falta de fonte."><label class="muted" title="Busca fontes novas sobre o pedido antes de reescrever (~10 a 20 créditos)"><input type="checkbox" name="pesquisar" value="1"> pode pesquisar</label><button>Ajustar</button></form>`;
}

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
// Antes × depois de cada ajuste pedido para a página (data/runs/<execução>/adjust-diff.json), do mais novo para
// o mais antigo: vale para rascunho, página nova e página no ar (22/10, editor: "ajuda a visualizar a melhora").
function adjustDiffsHtml(read: (path: string) => string | null, slug: string): string {
  try {
    const page = JSON.parse(read(`data/pages/${slug}.json`) ?? 'null');
    if (!page) return '';
    const runs = String(page.provenance.run_id).split('+').filter((x: string) => x.startsWith('editor:')).map((x: string) => x.slice(7)).reverse();
    const recs = runs
      .map((r: string) => JSON.parse(read(`data/runs/${r}/adjust-diff.json`) ?? 'null') as { instruction: string; diffs: { where: string; before: string; after: string }[] } | null)
      .filter((x): x is NonNullable<typeof x> => !!x && x.diffs.length > 0)
      .slice(0, 3);
    if (!recs.length) return '';
    return `<details class="sug"><summary class="muted">antes → depois dos seus ajustes (${recs.length})</summary>${recs
      .map((x) => `<p class="muted"><strong>Pedido:</strong> ${esc(x.instruction.slice(0, 240))}</p>${x.diffs.slice(0, 10).map((d) => `<div class="diff"><span class="muted">${esc(d.where)}</span><del>${esc(d.before.slice(0, 600))}</del><ins>${esc(d.after.slice(0, 600))}</ins></div>`).join('')}`)
      .join('')}</details>`;
  } catch {
    return '';
  }
}

function suggestionHtml(x: { review: FullReview; writer: string } | null): string {
  if (!x) return '';
  const r = x.review;
  const t = loadThresholds();
  const ok = r.publishable;
  // As 4 perguntas do padrão editorial primeiro (decide? leva à compra? leigo? rápida?), depois as métricas.
  const yn = (b: boolean | undefined) => (b === false ? 'não ✗' : 'sim');
  const why = [
    `decide: ${r.answers_primary_query === 'yes' ? 'sim' : r.answers_primary_query === 'partial' ? 'em parte' : 'não ✗'}`,
    `leva à compra: ${yn((r as { purchase_path?: boolean }).purchase_path)}`,
    `leigo: ${yn((r as { reader_fit?: boolean }).reader_fit)}`,
    `resposta rápida: ${yn((r as { quick_answer?: boolean }).quick_answer)}`,
    `enchimento ${Math.round(100 * r.filler_ratio)}% (limite ${Math.round(100 * t.max_filler_ratio)}%)${r.filler_ratio > t.max_filler_ratio ? ' ✗' : ''}`,
    `${r.decision_criteria.length} critérios de decisão (mínimo ${t.min_criteria})${r.decision_criteria.length < t.min_criteria ? ' ✗' : ''}`,
    r.concrete_guidance ? 'orienta o que fazer' : 'não orienta o que fazer ✗',
  ];
  return `<details class="sug"><summary>Sugestão do motor: <span class="b ${ok ? 'ok' : 'bad'}">${ok ? 'aceitar' : 'recusar'}</span> <span class="muted">${esc(why.join(' · '))}</span></summary>
<p class="muted">${esc(r.summary)}</p>${r.missing.length ? `<p class="muted"><strong>Faltou:</strong></p><ul class="muted">${r.missing.slice(0, 5).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}<p class="muted"><strong>Enchimento</strong> = parte dos blocos que a revisão apontou como dispensável (repete outro bloco, só descreve o catálogo de uma marca, transição vazia): sai sem a página perder nada.</p><p class="muted">Redator: ${esc(x.writer)}. Discorda? Aprove ou recuse com o seu motivo; cada veredito calibra a regra. Para pedir ajuste específico, use "Pedir ao motor".</p></details>`;
}

// Resposta a um pedido: só o mais recente fica à vista (e só por 6 h); os anteriores ficam recolhidos.
const answerHtml = (j: Job) => `<div class="flash" style="margin-top:8px"><strong>${esc(j.label.slice(8))}</strong> <span class="muted">${esc(fmt(j.started))}</span>${!j.ended ? ' <span class="b neutral">pensando…</span>' : ''}<pre>${esc(j.output.split('\n').filter((l) => /^(→|✓|✗)/.test(l)).join('\n') || (j.ended ? j.output.slice(-400) : ''))}</pre></div>`;

// Pedidos em texto livre (agente): caixa + últimas respostas + pedidos anotados para o desenvolvedor.
function requestsHtml(): string {
  const answers = jobs.filter((j) => j.label.startsWith('pedido:')).slice(0, 10);
  const lessons = loadEditorLessons().lessons;
  const devFile = join(DATA, 'dev-requests.json');
  const dev = existsSync(devFile) ? (JSON.parse(readFileSync(devFile, 'utf8')) as { summary: string; status: string; at: string }[]).filter((d) => d.status === 'aberto') : [];
  return `<form method="post" action="acao"><input type="hidden" name="acao" value="pedido"><textarea name="texto" required rows="2" style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)" placeholder="Ex.: crie pautas sobre colchão para quem sente calor · deixe a resposta curta do guia de molas mais direta · relatório de gastos da semana"></textarea><button class="ok" style="margin-top:6px">Enviar pedido</button></form>
<p class="muted">O motor transforma o pedido em ações que ele já faz com as travas de sempre (fila, refazer página com instrução, editar texto com auditoria, despublicar, relatório). Mudança de visual, código ou regra fica anotada para o desenvolvedor.</p>
${answers.slice(0, 1).filter((j) => !j.ended || Date.now() - Date.parse(j.started) < 6 * 3600_000).map(answerHtml).join('')}
${answers.length > 1 ? `<details style="margin-top:8px"><summary class="muted">pedidos anteriores (${answers.length - 1})</summary>${answers.slice(1).map(answerHtml).join('')}</details>` : ''}
${lessons.length ? `<details style="margin-top:8px"><summary class="muted">${lessons.length} lição(ões) dos seus pedidos que o redator segue em todas as páginas</summary><ul class="muted">${lessons.map((l) => `<li>${esc(l.text)} <span class="muted">(${esc(l.from)})</span> ${form('licao-remover', { licao: lessonId(l.text) }, 'Remover', 'bad', 'Remover esta lição? O redator deixa de segui-la nas próximas páginas.')}</li>`).join('')}</ul><p class="muted">Lições nascem dos seus pedidos de ajuste e motivos de recusa que valem para todas as páginas. Para criar uma, escreva o pedido como regra ("sempre...", "nunca...").</p></details>` : ''}
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

export const ADMIN_CSS = `<style>
.dcard{border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0;background:var(--card)}
.dcard.sg-publicar,.dcard.sg-aplicar,.dcard.sg-aprovar{border-left-color:var(--ok)}.dcard.sg-corrigir{border-left-color:#d08a1c}.dcard.sg-recusar{border-left-color:var(--bad)}
.dhead{margin:0 0 8px}.tag{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:var(--nbg);color:var(--n)}
.dl{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:6px 0}.dl dt{color:var(--muted);font-size:.85rem}.dl dd{margin:0}
@media (max-width:640px){.dl{grid-template-columns:1fr}.dl dt{margin-top:6px}}
.dactions{margin:10px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button.big{font-size:1rem;padding:8px 18px}
.dfix{margin:8px 0}.dfix textarea{width:100%;box-sizing:border-box;margin:6px 0;font:inherit}.acc{font-size:.88rem;margin-left:4px}
.b.warn{background:#fbefd9;color:#8a5a0c}.score{display:inline-block;font-weight:700;padding:1px 10px;border-radius:999px;background:var(--nbg)}.score.s4,.score.s3{background:var(--okbg);color:var(--ok)}.score.s2{background:#fbefd9;color:#8a5a0c}.score.s1,.score.s0{background:var(--badbg);color:var(--bad)}.dnext{margin:8px 0 2px}.dfoot{margin-top:8px;text-align:right}button.link{background:none;border:0;color:var(--muted);text-decoration:underline;padding:0;cursor:pointer;font-size:.82rem}
details.old{margin:24px 0 8px}
.adjust{margin-top:6px}.adjust input{min-width:160px}
.restored{outline:2px solid var(--amber,#f0b252)}
.result{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0;background:var(--card)}.result-head{margin:2px 0 6px}
.block{margin:10px 0;padding:10px 12px;border-radius:8px;background:var(--bg)}.block-title{margin:0 0 4px;font-weight:700}.pg{margin:8px 0 4px}.pg-title{margin:6px 0 2px}.why{font-size:.88rem;margin:2px 0}
.changes{list-style:none;padding:0;margin:8px 0}.changes li{padding:6px 0;border-top:1px solid var(--line)}.changes li:first-child{border-top:0}
.thumbs{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}.thumb{width:180px;height:auto;border-radius:6px;border:1px solid var(--line)}
.diff{margin:6px 0;font-size:.88rem}.diff del{display:block;background:var(--badbg);text-decoration:line-through;padding:2px 6px;border-radius:4px}.diff ins{display:block;background:var(--okbg);text-decoration:none;padding:2px 6px;border-radius:4px;margin-top:2px}
.sug{margin-top:6px}.sug summary{cursor:pointer;font-size:.88rem}.sug ul{margin:4px 0 6px 18px;padding:0}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:22px 0 6px;border-bottom:1px solid var(--line);padding-bottom:8px}
.pacts{display:flex;flex-direction:column;gap:6px;margin-top:6px;min-width:260px}
.tabs button{background:transparent;color:var(--muted);border:1px solid transparent;font-weight:600}
.tabs button.on{background:var(--card);color:var(--ink);border-color:var(--line)}
.tabs .count{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;background:var(--badbg);color:var(--bad);font-size:.75rem}
.flash{background:var(--nbg);border:1px solid var(--line);border-radius:10px;padding:10px 14px}.bad-flash{background:var(--badbg);color:var(--bad);border-color:var(--bad)}
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
    if (v === 'approve' && failedAdjust(jobs, slug) && f.get('forcar') !== '1') return 'o último ajuste desta página não foi salvo: peça de novo ou marque "aprovar assim mesmo"';
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
    // Regulador no Brasil é órgão público (.gov.br). 22/10: um catálogo de normas e um organismo certificador
    // entraram como "regulador", a classe de maior peso.
    if (classe === 'regulator' && !/\.gov\.br$/.test(host)) return `"${host}" não é órgão público: regulador é quem cria ou fiscaliza regra (gov.br). Organismo certificador ou laboratório: "Teste independente"; quem publica norma: "Norma técnica"; marca: "Fabricante".`;
    if (!/[A-ZÀ-Ú]/.test(pub)) return 'escreva o nome do publicador como ele aparece no texto (ex.: "Cavaletti", "BRICS OCP"), com maiúscula';
    return { label: `aprovar domínio ${host} (${pub})`, args: ['dominio-aprovar', host, classe, pub] };
  }
  if (acao === 'produto-adicionar') {
    const link = clean(f.get('link'), 500);
    const tipo = f.get('tipo') ?? '';
    const marca = clean(f.get('marca'), 40);
    const nome = clean(f.get('nome'), 80);
    if (!/^https:\/\/(www\.)?amazon\.com\.br\/.*(dp|gp\/product)\/[A-Z0-9]{10}/.test(link) && !/^[A-Z0-9]{10}$/.test(link)) return 'cole o link de um anúncio da amazon.com.br (com /dp/ no endereço)';
    if (!loadNiche().product_kinds.some((k) => k.id === tipo) || marca.length < 2 || nome.length < 5) return 'tipo, marca ou nome inválido';
    return { label: `adicionar produto: ${nome}`, args: ['produto-adicionar', link, tipo, marca, nome] };
  }
  if (acao === 'licao-remover') {
    const id = f.get('licao') ?? '';
    if (!/^[a-f0-9]{10}$/.test(id)) return 'lição inválida';
    return { label: 'remover lição do editor', args: ['licao-remover', id] };
  }
  if (acao === 'produto-reconferir' || acao === 'produto-remover') {
    const asin = f.get('asin') ?? '';
    if (!/^[A-Z0-9]{10}$/.test(asin)) return 'produto inválido';
    return { label: `${acao === 'produto-reconferir' ? 'reconferir' : 'remover'} produto ${asin}`, args: [acao, asin] };
  }
  if (acao === 'descartar') {
    const ramo = f.get('ramo') ?? '';
    if (!BRANCH.test(ramo)) return 'ramo inválido';
    const at = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(ramo);
    return { label: `descartar resultado do ${at ? `ciclo de ${at[3]}/${at[2]} ${at[4]}:${at[5]}` : ramo}`, args: [acao, ramo] };
  }
  if (acao === 'mesclar') {
    const ramo = f.get('ramo') ?? '';
    if (!BRANCH.test(ramo)) return 'ramo inválido';
    if (failedAdjust(jobs, ramo.replace(/^pagina\//, '').replace(/-\d{8}-\d{4}$/, '')) && f.get('forcar') !== '1') return 'o último ajuste desta página não foi salvo: peça de novo ou marque "aprovar assim mesmo"';
    // Os recusados são calculados aqui, a partir das mudanças reais do ramo: o formulário só diz o que manter.
    const keep = new Set(f.getAll('manter'));
    const all = gitChanges(`origin/${ramo}`).summary.items.map((i) => i.id);
    const excl = all.filter((id) => !keep.has(id));
    if (all.length && excl.length === all.length) return 'nenhum item marcado: para não aplicar nada, use "Descartar tudo"';
    // Rótulo para o editor: o ramo tem o nome da pauta tentada, que confunde quando o que entra é outra coisa.
    const at = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(ramo);
    const when = at ? `ciclo de ${at[3]}/${at[2]} ${at[4]}:${at[5]}` : ramo;
    return { label: `aplicar resultado do ${when}: ${all.length - excl.length} de ${all.length} mudança(s)${excl.length ? `, ${excl.length} recusada(s)` : ''}`, args: ['mesclar', ramo, ...(excl.length ? [excl.join(',')] : [])] };
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
  if (req.method === 'GET' && url.pathname === '/estado') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ v: panelVersion() }));
  }
  if (req.method === 'GET' && url.pathname === '/imagem') {
    // Miniatura de imagem nova de um resultado do motor, lida direto do ramo (só imagens geradas).
    const ramo = url.searchParams.get('ramo') ?? '';
    const path = url.searchParams.get('arquivo') ?? '';
    if (!BRANCH.test(ramo) || !/^site\/src\/assets\/generated\/[a-z0-9_-]+\.webp$/.test(path)) {
      res.writeHead(400);
      return res.end();
    }
    try {
      const img = execFileSync('git', ['show', `origin/${ramo}:${path}`], { cwd: ROOT, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=600' });
      return res.end(img);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/editar/')) {
    const page = loadPages().find((p) => p.slug === decodeURIComponent(url.pathname.slice('/editar/'.length)));
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page ? editHtml(page) : 'página não encontrada');
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    // Dados ilegíveis (ex.: cópia no meio de um merge) não derrubam o painel: mostra o erro e as últimas ações.
    let html: string;
    try {
      html = renderStatus(new Date(), { adminHtml: ADMIN_CSS + adminHtml(url.searchParams.get('msg')) }).replace('</body>', `${TABS_JS}${draftsJs(running() || cycleRunning() || queuedJobs().length ? 10 : 30, panelVersion())}</body>`);
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
    if (f.get('acao') === 'ajustar') {
      let ramo = f.get('ramo') ?? '';
      const slug = f.get('slug') ?? '';
      // Página que só existe num resultado pendente (rascunho novo): o ajuste vai para esse resultado, não
      // para o main (21/10: "página não existe" no ajuste da base box).
      if (ramo === 'main' && !loadPages().some((p) => p.slug === slug)) {
        const b = pendingBranches().find((x) => x.branch.replace(/^pagina\//, '').replace(/-\d{8}-\d{4}$/, '') === slug);
        if (b) ramo = b.branch;
      }
      const pedido = clean(f.get('pedido'), 600);
      if ((ramo !== 'main' && !BRANCH.test(ramo)) || !Slug.safeParse(slug).success || pedido.length < 5) msg = 'ajuste inválido';
      else {
        const dir = join(STATE, 'pedidos');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now().toString(36)}.txt`);
        writeFileSync(file, pedido);
        const pesquisar = f.get('pesquisar') === '1';
        msg = startJob(`ajustar ${slug}${pesquisar ? ' (com pesquisa)' : ''}: ${pedido.slice(0, 50)}`, ['ajustar', ramo, slug, file, ...(pesquisar ? ['pesquisar'] : [])]) ?? `ajustando ${slug}${pesquisar ? ' com pesquisa (alguns minutos)' : ''} (o auditor confere; a prévia se refaz em até 5 min)`;
      }
    } else if (f.get('acao') === 'pedido') {
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
        msg = startJob(`editar ${slug}`, ['editar', slug, file]) ?? `na fila: editar ${slug} (o auditor confere os blocos alterados; resultado em "Últimas ações")`;
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
      msg = typeof j === 'string' ? j : (startJob(j.label, j.args) ?? `na fila: ${j.label} (roda assim que chegar a vez; acompanhe em "Últimas ações")`);
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
    if (!running() && !queuedJobs().length && head() !== started) process.exit(0);
  }, 60_000).unref();
  createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`erro: ${(e as Error).message}`);
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`painel admin em 127.0.0.1:${PORT}`));
}
