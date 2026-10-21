import { reuseEvidence } from './reuse.ts';
import { ensureAnchors } from './links.ts';
import { ensureSearchLinks } from './search-links.ts';
import { discoverIdeas, promoteIdeas } from './ideas.ts';
import { live, newRunId } from '../runs.ts';
import { fetchSnapshot, hasKey, homeOrder, HOME_ORDER_FILE, latestSnapshot, opportunities } from '../gsc.ts';
import { firstForbidden } from '@bem-apoiado/core';
import { nextReaudit, reauditPage } from './reaudit.ts';
import { MODELS } from '../models.ts';
import { BRIEF_SYSTEM, BriefOut, ensureImages } from '../images.ts';
import { applyCalibration, calibrate, loadVerdicts } from '../feedback.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callJson, creditsLeft, creditsSpent } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { creditsThisMonth } from '../search.ts';
import { DATA, loadPages, loadProducts, loadTopics, readState, ROOT, STATE_DIR, writeJson, writeState } from '../store.ts';
import { TopicBrief, type PageSpec, type Product } from '@bem-apoiado/core';
import { findProductsFromAmazon } from './products.ts';
import { REFRESH_AFTER_DAYS, refreshProducts } from './refresh.ts';
import { discoverSources } from './discover.ts';
import { editPage } from './edit.ts';
import { improveTopic, MAX_IMPROVE_ATTEMPTS } from './improve.ts';
import { buildPage, styleIssues } from './page.ts';
import { adjustWithResearch } from './requests.ts';
import { planTopic } from './plan.ts';
import { loadTopic, research } from './research.ts';

// Piloto automático: um ciclo = uma pauta, do plano à página revisada. Não mexe em git (o script
// de ciclo faz isso); só escreve em data/ e deixa um resumo para o PR em .pr/.

const Queue = z.object({
  items: z.array(z.object({ query: z.string().min(3), added_at: z.string(), origin: z.string().default('manual') })),
});

// Fila editada pelo painel: adiciona no fim (sem duplicar) ou remove pela consulta exata.
export function editQueue(op: 'add' | 'remove', query: string, now = new Date()): boolean {
  const path = join(DATA, 'queue.json');
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { items: [] };
  const q = Queue.parse(raw);
  const key = slugOf(query);
  const has = q.items.some((i) => slugOf(i.query) === key);
  if (op === 'add' && (has || query.trim().length < 3)) return false;
  if (op === 'remove' && !has) return false;
  const items = op === 'add'
    ? [...q.items, { query: query.trim(), added_at: now.toISOString().slice(0, 10), origin: 'painel' }]
    : q.items.filter((i) => slugOf(i.query) !== key);
  writeFileSync(path, JSON.stringify({ ...raw, items }, null, 2) + '\n');
  return true;
}

// Teto diário de créditos de IA, somado entre ciclos (contador fora do git).
export const DAILY_CREDIT_CAP = Number(process.env.BEM_DAILY_CREDIT_CAP ?? 150);
const LEDGER = join(STATE_DIR, 'llm-usage.json');
const today = () => new Date().toISOString().slice(0, 10);
export function creditsToday(): number {
  return existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, 'utf8'))[today()] ?? 0) : 0;
}
function recordCredits(c: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const l = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  l[today()] = (l[today()] ?? 0) + c;
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

export interface CycleResult {
  // MAINTENANCE: nenhuma pauta nova, mas o catálogo de produtos mudou (renovação ou produtos novos).
  status: 'PAGE_APPROVED' | 'PAGE_DRAFT' | 'NOTHING_TO_DO' | 'DAILY_CAP' | 'STOPPED' | 'MAINTENANCE';
  slug?: string;
  query?: string;
  steps: string[];
  credits: number;
  review?: unknown;
}

const slugOf = (q: string) => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Próxima pauta: primeira da fila sem página aprovada e que ainda não esgotou as tentativas.
export function nextQuery(): string | null {
  const path = join(DATA, 'queue.json');
  if (!existsSync(path)) return null;
  const q = Queue.parse(JSON.parse(readFileSync(path, 'utf8')));
  const topics = new Map(loadTopics().map((t) => [t.slug, t]));
  const approved = new Set(loadPages().filter((p) => p.status !== 'draft').map((p) => p.slug));
  // Pauta com ramo pagina/* ainda não mesclado: o aprendizado dela ainda não está no main.
  // Esperar o merge em vez de refazer (e pagar de novo) o mesmo trabalho.
  const pending = new Set((process.env.BEM_PENDING_SLUGS ?? '').split(',').filter(Boolean));
  const planFails = readState<Record<string, number>>('plan-failures.json', {});
  for (const item of q.items) {
    if ((planFails[item.query] ?? 0) >= 2) continue;
    const slug = slugOf(item.query);
    if (approved.has(slug) || pending.has(slug)) continue;
    const t = topics.get(slug);
    if (t && t.researched_source_ids.length > 0 && (t.improve_attempts >= MAX_IMPROVE_ATTEMPTS || t.evidence_gaps.length === 0)) continue;
    return item.query;
  }
  return null;
}

// Produtos para páginas no ar: página aprovada (pelo motor ou pelo editor no painel) cuja pauta tem
// tipos de produto mas nenhum produto desses tipos no catálogo. Uma tentativa por página por semana.
export const PRODUCTS_RETRY_DAYS = 7;
export const PRODUCTS_MIN_CREDITS = 20;

export const PRODUCTS_PER_PAGE = 3;

export function pagesNeedingProducts(pages: PageSpec[], topics: TopicBrief[], products: Product[], attempts: Record<string, string>, now = new Date()): string[] {
  const kindsOf = new Map(topics.map((t) => [t.slug, t.product_kinds]));
  return pages
    .filter((p) => p.status !== 'draft')
    .filter((p) => {
      const kinds = kindsOf.get(p.slug) ?? [];
      // Meta: PRODUCTS_PER_PAGE exemplos por página (os de tipo compartilhado com outras páginas contam).
      if (kinds.length === 0 || products.filter((x) => kinds.includes(x.kind)).length >= PRODUCTS_PER_PAGE) return false;
      const last = attempts[p.slug];
      return !last || now.getTime() - new Date(last).getTime() >= PRODUCTS_RETRY_DAYS * 86_400_000;
    })
    .map((p) => p.slug);
}

// Manutenção do catálogo dentro do ciclo (e não num timer separado): as mudanças saem no mesmo ramo
// e passam pelo mesmo gate/aceite; se um ciclo falha, o próximo retoma sozinho, sem depender de dia da semana.
// Imagens que faltam (tipo novo do nicho, capa de página aprovada): até 2 por ciclo, ~5 créditos cada.
// Falha aqui nunca derruba o ciclo; a página fica com a imagem do tipo (ou a ilustração) até a próxima vez.
async function maintainImages(steps: string[]): Promise<boolean> {
  if (creditsLeft() < IMAGE_MIN_CREDITS) return false;
  try {
    const writeBrief = async (subject: string) =>
      (await callJson({ role: 'extractor', system: BRIEF_SYSTEM, user: subject, schema: BriefOut, schemaName: 'image_brief', maxTokens: 600 })).data;
    const made = await ensureImages(ROOT, loadNiche().product_kinds, loadPages(), writeBrief, { max: 2 });
    if (made.length) steps.push(`imagens: ${made.map((m) => m.id).join(', ')} (~${made.reduce((t, m) => t + m.credits, 0).toFixed(1)} créditos)`);
    return made.length > 0;
  } catch (e) {
    steps.push(`imagens: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}
const IMAGE_MIN_CREDITS = 15;

// Re-auditoria: uma página publicada por ciclo (auditor trocado ou mais de 30 dias). Com o Luna custa
// ~1 crédito; o remendo, quando há, é do redator. Página corrigida só vai ao ar depois do aceite humano.
async function maintainAudit(runId: string, steps: string[]): Promise<boolean> {
  const last = readState<Record<string, { at: string; model: string }>>('reaudit.json', {});
  const page = nextReaudit(loadPages(), last);
  if (!page || creditsLeft() < REAUDIT_MIN_CREDITS) return false;
  const r = await reauditPage(page, runId);
  if (r.status !== 'SAFE_STOP') writeState('reaudit.json', { ...last, [page.slug]: { at: new Date().toISOString(), model: MODELS.auditor.id } });
  steps.push(
    r.status === 'CLEAN' ? `re-auditoria de ${page.slug}: sem problemas`
      : r.status === 'FIXED' ? `re-auditoria de ${page.slug}: ${r.fixed.length} bloco(s) corrigido(s) (${r.fixed.join(', ')}); confira na prévia antes de aceitar`
      : r.status === 'OPEN' ? `re-auditoria de ${page.slug}: ${r.open.length} problema(s) sem correção segura; página publicada mantida`
      : `re-auditoria de ${page.slug}: parou (${r.reason})`,
  );
  return r.status === 'FIXED';
}
const REAUDIT_MIN_CREDITS = 20;

// Página no ar com fonte ainda não pesquisada (ex.: reextraída com tabela legível) e lacunas abertas:
// pesquisa só essas fontes e reescreve. Passou na auditoria e na revisão: vai para o ramo (aceite humano,
// com prévia). Não passou: a página publicada volta exatamente como estava. Uma por ciclo, no máximo 1x/semana.
async function maintainEnrich(runId: string, steps: string[]): Promise<boolean> {
  const attempts = readState<Record<string, string>>('enrich-attempts.json', {});
  const week = 7 * 86_400_000;
  const topics = new Map(loadTopics().map((t) => [t.slug, t]));
  const page = loadPages().find((p) => {
    const t = topics.get(p.slug);
    return p.status !== 'draft' && t && t.evidence_gaps.length > 0 && t.source_ids.some((s) => !t.researched_source_ids.includes(s)) && !(attempts[p.slug] && Date.now() - Date.parse(attempts[p.slug]!) < week);
  });
  if (!page || creditsLeft() < ENRICH_MIN_CREDITS) return false;
  writeState('enrich-attempts.json', { ...attempts, [page.slug]: new Date().toISOString() });
  const t = topics.get(page.slug)!;
  const only = t.source_ids.filter((s) => !t.researched_source_ids.includes(s));
  const original = readFileSync(join(DATA, 'pages', `${page.slug}.json`), 'utf8');
  // Execução própria: no mesmo ciclo pode haver outra página, e os registros não podem se sobrescrever.
  const rid = newRunId(`${page.slug}-enrich`);
  try {
    const r = await research(page.slug, rid, undefined, only);
    if (r.accepted.length === 0) {
      steps.push(`enriquecimento de ${page.slug}: ${only.length} fonte(s) relida(s), nenhuma evidência nova`);
      return true; // a pauta registra as fontes como pesquisadas
    }
    const p = await buildPage(page.slug, rid);
    if (p.status !== 'PASS') {
      writeFileSync(join(DATA, 'pages', `${page.slug}.json`), original);
      steps.push(`enriquecimento de ${page.slug}: +${r.accepted.length} evidências, mas a nova versão não passou (${p.status}); página publicada mantida`);
      return true;
    }
    steps.push(`enriquecimento de ${page.slug}: +${r.accepted.length} evidências, página reescrita e aprovada pela auditoria; confira na prévia antes de aceitar`);
    return true;
  } catch (e) {
    writeFileSync(join(DATA, 'pages', `${page.slug}.json`), original);
    steps.push(`enriquecimento de ${page.slug}: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}
const ENRICH_MIN_CREDITS = 40;
const PAGE_MIN_CREDITS = 15;

// Descoberta de pautas (autocompletar do Google + triagem barata), uma vez por semana; as 5 melhores
// ideias novas entram na fila. Custa ~1 crédito. A lista completa fica em data/ideas.json (painel).
async function maintainIdeas(steps: string[]): Promise<boolean> {
  const last = readState<{ at: string } | null>('ideas-run.json', null);
  if (last && Date.now() - Date.parse(last.at) < 7 * 86_400_000) return false;
  try {
    const r = await discoverIdeas();
    writeState('ideas-run.json', { at: new Date().toISOString() });
    const promoted = promoteIdeas((q) => editQueue('add', q), 5);
    steps.push(`ideias: ${r.added.length} pauta(s) nova(s) achadas no autocompletar do Google${promoted.length ? `; na fila: ${promoted.map((q) => `"${q}"`).join(', ')}` : ''}`);
    return r.added.length > 0 || promoted.length > 0;
  } catch (e) {
    steps.push(`ideias: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}

// Search Console (se conectado): retrato diário; pautas novas a partir de buscas fortes sem página (até 2
// por semana, fora de tema de saúde vetado); ordem da home pelos dados do Google. Só a fila e a ordem
// entram no git, e só quando mudam.
async function maintainGsc(steps: string[]): Promise<boolean> {
  if (!hasKey()) return false;
  try {
    const last = latestSnapshot();
    const snap = last && Date.now() - Date.parse(last.fetched_at) < 20 * 3600_000 ? last : await fetchSnapshot();
    let changed = false;
    const pages = loadPages().filter((p) => p.status !== 'draft');
    const order = homeOrder(snap, pages.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((p) => p.slug));
    const prev = existsSync(HOME_ORDER_FILE) ? (JSON.parse(readFileSync(HOME_ORDER_FILE, 'utf8')) as { order: string[] }).order : [];
    if (snap.rows.length > 0 && JSON.stringify(order) !== JSON.stringify(prev)) {
      writeFileSync(HOME_ORDER_FILE, JSON.stringify({ order, source: 'Search Console', period: `${snap.start}..${snap.end}` }, null, 2) + '\n');
      steps.push(`home reordenada pelo Search Console (${order.slice(0, 3).join(', ')}…)`);
      changed = true;
    }
    const added = readState<{ at: string }[]>('gsc-topics.json', []).filter((x) => Date.now() - Date.parse(x.at) < 7 * 86_400_000);
    if (added.length < 2) {
      const queuePath = join(DATA, 'queue.json');
      const queued = new Set(existsSync(queuePath) ? Queue.parse(JSON.parse(readFileSync(queuePath, 'utf8'))).items.map((i) => slugOf(i.query)) : []);
      const forbidden = loadNiche().forbidden_terms;
      const ops = opportunities(snap, new Set(loadTopics().map((t) => t.slug)), queued, slugOf);
      for (const t of ops.newTopics.filter((x) => !firstForbidden(x.query, forbidden)).slice(0, 2 - added.length)) {
        if (editQueue('add', t.query)) {
          added.push({ at: new Date().toISOString() });
          steps.push(`pauta nova do Search Console: "${t.query}" (${t.impressions} impressões, aparecemos via /${t.page}/)`);
          changed = true;
        }
      }
      writeState('gsc-topics.json', added);
    }
    return changed;
  } catch (e) {
    steps.push(`Search Console: falhou (${(e as Error).message.slice(0, 100)})`);
    return false;
  }
}

// Resumo que não passa na trava (mais de 3 frases, abre com norma, "trechos citados"): reescreve a resposta
// curta e o "Como decidir" de uma página no ar por ciclo, com as evidências que ela já tem (~2–3 créditos).
// Sai como resultado para o editor aceitar; tentativa no máximo 1x por semana por página.
export const SUMMARY_FIX = 'Reescreva a resposta curta e o "Como decidir" para quem vai comprar, em palavras simples: a resposta curta em até 3 frases, começando pela resposta prática (o que escolher ou conferir), sem abrir com norma ou regulador e sem "trechos citados".';
async function maintainSummary(runId: string, steps: string[]): Promise<boolean> {
  const tried = readState<Record<string, string>>('summary-fix.json', {});
  const weak = (p: PageSpec) => (p.provenance.review as { quick_answer?: boolean } | undefined)?.quick_answer === false || styleIssues({ title: p.title, description: p.description, verdict: p.verdict, sections: p.sections } as never).some((i) => i.ref === 'verdict' || /trechos citados/.test(i.msg));
  const page = loadPages().find((p) => p.status !== 'draft' && weak(p) && !(tried[p.slug] && Date.now() - Date.parse(tried[p.slug]!) < 7 * 86_400_000));
  if (!page || creditsLeft() < 10) return false;
  writeState('summary-fix.json', { ...tried, [page.slug]: new Date().toISOString() });
  try {
    const msg = await adjustWithResearch(page.slug, SUMMARY_FIX, runId, undefined, { research: false, learn: false });
    steps.push(`resumo de ${page.slug}: ${msg.startsWith('texto ajustado') ? 'reescrito para leigo (confira na prévia antes de aceitar)' : msg.slice(0, 120)}`);
    return msg.startsWith('texto ajustado');
  } catch (e) {
    steps.push(`resumo de ${page.slug}: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}

// Âncoras dos links internos para páginas no ar que ainda não têm (até 5 por ciclo, ~0,1 crédito cada).
// O site liga a primeira ocorrência delas no texto das outras páginas; o texto não muda.
async function maintainLinks(steps: string[]): Promise<boolean> {
  try {
    const done = await ensureAnchors(loadPages());
    if (done.length) steps.push(`links internos: âncoras para ${done.join(', ')}`);
    // Buscas na Amazon (link com a nossa tag) para página no ar que ainda não tem: ~0,05 crédito cada.
    const amz = await ensureSearchLinks(loadPages());
    if (amz.length) steps.push(`buscas na Amazon para ${amz.join(', ')}`);
    return done.length > 0 || amz.length > 0;
  } catch (e) {
    steps.push(`links internos: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}

async function maintainProducts(runId: string, steps: string[], only?: string): Promise<boolean> {
  let changed = false;
  if (!only) {
    try {
      const r = await refreshProducts(runId);
      if (r.refreshed.length || r.retired.length) {
        changed = true;
        steps.push(`produtos: ${r.refreshed.length} disponibilidade(s) renovada(s), ${r.retired.length} retirado(s)${r.retired.length ? ` (${r.retired.map((x) => `${x.asin}: ${x.reason}`).join('; ')})` : ''}`);
      }
    } catch (e) {
      steps.push(`produtos: renovação falhou (${(e as Error).message.slice(0, 80)})`);
    }
  }
  const attempts = readState<Record<string, string>>('products-attempts.json', {});
  const needy = pagesNeedingProducts(loadPages(), loadTopics(), loadProducts(), attempts).filter((s) => !only || s === only);
  for (const slug of needy.slice(0, 1)) {
    if (creditsLeft() < PRODUCTS_MIN_CREDITS) {
      steps.push(`produtos para ${slug}: adiado (orçamento do ciclo)`);
      break;
    }
    attempts[slug] = new Date().toISOString();
    writeState('products-attempts.json', attempts);
    try {
      const r = await findProductsFromAmazon(slug, runId);
      if (r.added.length) changed = true;
      steps.push(`produtos para ${slug}: ${r.added.length} adicionado(s)${r.added.length ? ` (${r.added.map((a) => a.label).join('; ')})` : ''}`);
    } catch (e) {
      steps.push(`produtos para ${slug}: falhou (${(e as Error).message.slice(0, 80)})`);
    }
  }
  return changed;
}

export async function runCycle(runId: string): Promise<CycleResult> {
  // Cada passo concluído vai também para o status ao vivo do painel.
  const steps: string[] = new Proxy([] as string[], {
    get(t, k, r) {
      if (k === 'push') return (...xs: string[]) => { const n = t.push(...xs); live({ steps: [...t] }); return n; };
      return Reflect.get(t, k, r);
    },
  });
  const done = (r: Omit<CycleResult, 'credits'>): CycleResult => {
    const credits = creditsSpent();
    recordCredits(credits);
    const result = { ...r, credits };
    writePrSummary(result, runId);
    return result;
  };
  if (creditsToday() >= DAILY_CREDIT_CAP) return { status: 'DAILY_CAP', steps: [`teto diário de ${DAILY_CREDIT_CAP} créditos já atingido`], credits: 0 };

  // Antes de produzir: se os vereditos do editor mostram limites melhores, a revisão passa a usá-los.
  const cal = calibrate(loadVerdicts());
  if (applyCalibration(cal)) steps.push(`revisão recalibrada: enchimento ≤ ${cal.best.max_filler_ratio}, critérios ≥ ${cal.best.min_criteria} (${cal.best.agree}/${cal.labels} vereditos)`);

  // Manutenção primeiro (todas rodam; qualquer mudança vira ramo de manutenção se não houver pauta).
  const m1 = await maintainProducts(runId, steps);
  const m2 = await maintainImages(steps);
  const m3 = await maintainAudit(runId, steps);
  const m4 = await maintainEnrich(runId, steps);
  const m5 = await maintainGsc(steps);
  const m6 = await maintainIdeas(steps);
  const m7 = await maintainLinks(steps);
  const m8 = await maintainSummary(runId, steps);
  const maintained = m1 || m2 || m3 || m4 || m5 || m6 || m7 || m8;

  // Página nova custa ~8–12 créditos com o Haiku (até ~25 se escalar para o Sonnet): sem isso sobrando, deixa para o próximo ciclo em vez de parar no
  // meio da redação (gasto perdido). A manutenção já feita sai normalmente.
  const query = creditsLeft() >= PAGE_MIN_CREDITS ? nextQuery() : null;
  if (!query && creditsLeft() < PAGE_MIN_CREDITS) steps.push(`página nova adiada para o próximo ciclo (restam ${creditsLeft().toFixed(0)} créditos no teto)`);
  if (!query) {
    const why = creditsLeft() < PAGE_MIN_CREDITS ? 'sem orçamento para página nova neste ciclo' : 'fila sem pauta pendente';
    if (maintained) return done({ status: 'MAINTENANCE', slug: 'manutencao', steps: [...steps, why] });
    recordCredits(creditsSpent()); // tentativa de produtos sem resultado também gasta
    return { status: 'NOTHING_TO_DO', steps: [...steps, 'fila vazia ou todas as pautas resolvidas/esgotadas'], credits: creditsSpent() };
  }

  // Falha no planejamento (ex.: saída inválida do modelo) não derruba o ciclo: a pauta sai da vez após 2.
  let planned: Awaited<ReturnType<typeof planTopic>>;
  try {
    planned = await planTopic(query);
  } catch (e) {
    const fails = readState<Record<string, number>>('plan-failures.json', {});
    fails[query] = (fails[query] ?? 0) + 1;
    writeState('plan-failures.json', fails);
    steps.push(`planejamento de "${query}" falhou (${(e as Error).message.slice(0, 120)})${fails[query]! >= 2 ? '; pauta sai da vez' : ''}`);
    recordCredits(creditsSpent());
    return { status: 'NOTHING_TO_DO', steps, credits: creditsSpent() };
  }
  steps.push(planned.created ? `pauta planejada (${planned.topic.questions.length} perguntas)` : 'pauta já existia');
  // Evidência já verificada em pautas vizinhas entra antes da pesquisa nova (mais completa, mais barata).
  try {
    const re = await reuseEvidence(planned.topic.slug);
    if (re.reused) steps.push(`reuso: ${re.reused} evidência(s) já verificadas de ${re.sources} fonte(s) de pautas vizinhas`);
  } catch (e) {
    steps.push(`reuso: falhou (${(e as Error).message.slice(0, 80)})`);
  }
  const topic = loadTopics().find((t) => t.slug === planned.topic.slug) ?? planned.topic;

  if (topic.researched_source_ids.length > 0 && topic.evidence_gaps.length > 0) {
    // Já tentada e reprovada: nova tentativa dirigida às lacunas.
    const r = await improveTopic(topic.slug, runId);
    steps.push(`improve: ${r.status === 'DONE' ? `página ${r.page} (+${r.new_sources} fontes, +${r.new_claims} evidências)` : r.reason}`);
  } else {
    const d = await discoverSources(topic.slug, runId);
    steps.push(`discover: ${d.added.length} fontes (${d.queries.length} buscas)`);
    // Sem fonte nova, ainda pode haver evidência reaproveitada suficiente: só para se não houver nenhuma fonte.
    if (d.added.length === 0 && loadTopics().find((t) => t.slug === topic.slug)!.source_ids.length === 0) return done({ status: 'STOPPED', slug: topic.slug, query, steps: [...steps, 'sem fontes aceitas'] });
    const r = await research(topic.slug, runId);
    steps.push(`research: ${r.accepted.length} evidências, ${r.unanswered.length} perguntas sem resposta`);
    const p = await buildPage(topic.slug, runId);
    steps.push(`page: ${p.status}${p.status === 'SAFE_STOP' ? ` (${p.reason})` : ''}`);
    // Parou sem página e sem lacuna registrada: as perguntas sem resposta viram lacunas, senão a fila trata
    // a pauta como esgotada e nunca volta a ela (cadeira de escritório, 21/10: 0 evidências, 0 lacunas).
    const t = loadTopic(topic.slug);
    if (p.status === 'SAFE_STOP' && t.evidence_gaps.length === 0 && r.unanswered.length) {
      writeJson(join(DATA, 'topics', `${topic.slug}.json`), TopicBrief.parse({ ...t, evidence_gaps: t.questions.filter((q) => r.unanswered.includes(q.id)).map((q) => q.text) }));
    }
    if (p.status === 'PASS') {
      const e = await editPage(p.page, runId);
      steps.push(`edit: ${e.status}`);
    }
  }
  const page = loadPages().find((p) => p.slug === topic.slug);
  const status = page && page.status !== 'draft' ? 'PAGE_APPROVED' : 'PAGE_DRAFT';
  // Página aprovada neste ciclo já sai com exemplos à venda, se sobrar orçamento.
  if (status === 'PAGE_APPROVED') {
    await maintainProducts(runId, steps, topic.slug);
    await maintainImages(steps);
  }
  return done({ status, slug: topic.slug, query, steps });
}

// Resumo que o script de ciclo usa como título e corpo do PR.
function writePrSummary(r: CycleResult, runId: string): void {
  const dir = join(ROOT, '.pr');
  mkdirSync(dir, { recursive: true });
  const title = r.status === 'MAINTENANCE' ? 'Manutenção: produtos, imagens e re-auditoria' : r.status === 'PAGE_APPROVED' ? `Página nova: ${r.query}` : `Tentativa (rascunho): ${r.query}`;
  const body = [
    `**Pauta:** ${r.query ?? '— (manutenção)'}`,
    `**Resultado:** ${r.status === 'MAINTENANCE' ? '🔧 manutenção: produtos (disponibilidade, exemplos novos), imagens e correções da re-auditoria em páginas no ar; veja a prévia antes de aceitar' : r.status === 'PAGE_APPROVED' ? '✅ aprovada pela auditoria e pela revisão editorial: o merge publica' : '📝 rascunho: não será publicada; o merge só guarda o aprendizado (fontes, evidências, lacunas)'}`,
    '',
    '**Etapas:**',
    ...r.steps.map((s) => `- ${s}`),
    '',
    `**Custo do ciclo:** ~${r.credits.toFixed(1)} créditos de IA · hoje: ~${creditsToday().toFixed(1)} de ${DAILY_CREDIT_CAP} · Tavily no mês: ${creditsThisMonth()}`,
    `**Execução:** \`${runId}\` (detalhes em data/runs/)`,
  ].join('\n');
  writeFileSync(join(dir, 'title.txt'), title);
  writeFileSync(join(dir, 'body.md'), body);
  writeFileSync(join(dir, 'slug.txt'), r.slug ?? 'ciclo');
}
