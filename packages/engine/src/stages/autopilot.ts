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
import { creditsThisMonth, SearchError } from '../search.ts';
import { DATA, loadPages, loadProducts, loadTopics, readState, ROOT, STATE_DIR, writeJson, writeState } from '../store.ts';
import { TopicBrief, type PageSpec, type Product } from '@bem-apoiado/core';
import { findProductsFromAmazon } from './products.ts';
import { REFRESH_AFTER_DAYS, refreshProducts } from './refresh.ts';
import { discoverSources, loadRegistry, makersFor } from './discover.ts';
import { decisionReadiness, logReadiness, saveRules } from './readiness.ts';
import { editPage } from './edit.ts';
import { improveTopic, MAX_IMPROVE_ATTEMPTS, retryOff } from './improve.ts';
import { buildPage, styleIssues } from './page.ts';
import { adjustWithResearch } from './requests.ts';
import { withoutDuplicates } from './duplicates.ts';
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
  // Tirada da fila pelo editor: a ideia correspondente vira "descartada" e some da lista de sugestões (22/10:
  // duas pautas tiradas da fila voltaram pelo botão "adicionar" das ideias, que ainda as mostrava como novas).
  if (op === 'remove') {
    const f = join(DATA, 'ideas.json');
    if (existsSync(f)) {
      const d = JSON.parse(readFileSync(f, 'utf8'));
      const list = Array.isArray(d) ? d : d.ideas ?? [];
      let touched = false;
      for (const i of list) if (slugOf(i.query) === key && i.status !== 'descartada') { i.status = 'descartada'; i.reason = 'tirada da fila pelo editor'; touched = true; }
      if (touched) writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
    }
  }
  return true;
}

// Teto diário de créditos de IA, somado entre ciclos (contador fora do git).
export const DAILY_CREDIT_CAP = Number(process.env.BEM_DAILY_CREDIT_CAP ?? 150);
// Ciclo manual (botão do painel) fora do teto diário até 20 páginas no ar; o limite por ciclo continua valendo.
export const MANUAL_FREE_UNTIL_PAGES = 20;
export function dailyCapFor(manual = process.env.BEM_MANUAL_RUN === '1', livePages = loadPages().filter((p) => p.status !== 'draft').length): number {
  return manual && livePages < MANUAL_FREE_UNTIL_PAGES ? Number.POSITIVE_INFINITY : DAILY_CREDIT_CAP;
}
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

export const slugOf = (q: string) => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Pauta de um tipo sem pelo menos 2 fabricantes cadastrados não anda (22/10: "mesa regulável vale a pena" saiu
// só com Flexform achada em busca aberta e regras de teleatendimento; o juiz reprovou com razão). Tipos: os da
// pauta, se já planejada; senão, os cujo nome aparece na dúvida ("mesa", "suporte", "colchão"...). Sem tipo
// reconhecido, não bloqueia. O painel mostra "faltam fabricantes" para o editor aprovar domínios.
export const MIN_MAKERS = 2;
// Pauta adiada pela checagem antes da redação sai da vez por alguns dias (22/10: o protetor de colchão adiado
// continuava "a próxima" e o ciclo manual seguinte refaria a mesma busca sem fonte, em vez de ir à pauta seguinte).
export const DEFERRED_FILE = 'deferred-topics.json';
export const DEFER_DAYS = 3;
export function isDeferred(slug: string, now = new Date()): boolean {
  const at = readState<Record<string, string>>(DEFERRED_FILE, {})[slug];
  return !!at && now.getTime() - Date.parse(at) < DEFER_DAYS * 86_400_000;
}
export function lacksMakers(query: string, topic?: TopicBrief): boolean {
  try {
    return lacksMakersOrThrow(query, topic);
  } catch {
    return false; // sem nicho ou cadastro legível (instalação nova, teste): não bloqueia
  }
}
function lacksMakersOrThrow(query: string, topic?: TopicBrief): boolean {
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const kinds = topic?.product_kinds.length
    ? topic.product_kinds
    : loadNiche().product_kinds.filter((k) => k.id !== 'outro' && norm(query).includes(norm(k.label).split(' ')[0]!)).map((k) => k.id);
  if (!kinds.length) return false;
  const reg = loadRegistry();
  return kinds.every((k) => new Set(makersFor([k], reg).map((m) => m.publisher)).size < MIN_MAKERS);
}

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
    if (t && t.researched_source_ids.length > 0 && (t.improve_attempts >= MAX_IMPROVE_ATTEMPTS || t.evidence_gaps.length === 0 || retryOff(t.product_kinds))) continue;
    if (lacksMakers(item.query, t)) continue;
    if (isDeferred(slug)) continue;
    return item.query;
  }
  return null;
}

// Situação de cada pauta da fila, pela mesma regra do nextQuery (para o painel mostrar o que anda e o que não).
export type QueueState = 'no ar' | 'rascunho' | 'esperando você' | 'esgotada' | 'falhou no planejamento' | 'faltam fabricantes' | 'adiada (falta fonte)' | 'próxima' | 'na fila';
export function queueStatus(pendingSlugs: Set<string>): { query: string; state: QueueState }[] {
  const path = join(DATA, 'queue.json');
  if (!existsSync(path)) return [];
  const q = Queue.parse(JSON.parse(readFileSync(path, 'utf8')));
  const topics = new Map(loadTopics().map((t) => [t.slug, t]));
  const pages = new Map(loadPages().map((p) => [p.slug, p]));
  const planFails = readState<Record<string, number>>('plan-failures.json', {});
  let next = false;
  return q.items.map((item) => {
    const slug = slugOf(item.query);
    const page = pages.get(slug);
    const t = topics.get(slug);
    let state: QueueState;
    if (page && page.status !== 'draft') state = 'no ar';
    else if (pendingSlugs.has(slug)) state = 'esperando você';
    else if ((planFails[item.query] ?? 0) >= 2) state = 'falhou no planejamento';
    else if (t && t.researched_source_ids.length > 0 && (t.improve_attempts >= MAX_IMPROVE_ATTEMPTS || t.evidence_gaps.length === 0 || retryOff(t.product_kinds))) state = page ? 'rascunho' : 'esgotada';
    else if (lacksMakers(item.query, t)) state = 'faltam fabricantes';
    else if (isDeferred(slug)) state = 'adiada (falta fonte)';
    else if (!next) { state = 'próxima'; next = true; }
    else state = 'na fila';
    return { query: item.query, state };
  });
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
    // Imagem gerada fica no resultado do ciclo até o aceite; o main ainda não a tem. Sem esta memória fora do git, cada
    // ciclo gerava de novo a mesma capa (24/10: a do baú 4 vezes, ~15 créditos à toa). Vale 14 dias.
    const recent = readState<Record<string, string>>('images-made.json', {});
    const skip = new Set(Object.entries(recent).filter(([, at]) => Date.now() - Date.parse(at) < 14 * 86_400_000).map(([id]) => id));
    const made = await ensureImages(ROOT, loadNiche().product_kinds, loadPages(), writeBrief, { max: 2, products: loadProducts(), skip });
    if (made.length) writeState('images-made.json', { ...recent, ...Object.fromEntries(made.map((m) => [m.id, new Date().toISOString()])) });
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

// Página no ar marcada em data/source-gaps.json (ajuste do editor que não melhorou porque falta fonte, não texto) e
// sem fonte nova para ler: busca fonte para a lacuna, uma vez por semana por página, por até 3 semanas. O que achar entra na pauta como fonte
// ainda não pesquisada, e o enriquecimento acima lê e reescreve (com aceite no quadro). 23/10: a cadeira
// ergonômica ou gamer teve 8 ajustes de texto sem ganho; faltava fonte que dissesse quando escolher cada tipo.
async function maintainGapSources(steps: string[]): Promise<boolean> {
  const sf = join(DATA, 'source-gaps.json');
  if (!existsSync(sf)) return false;
  const marked = JSON.parse(readFileSync(sf, 'utf8')) as Record<string, { at: string; gaps: string[]; tries: number; last?: string }>;
  const week = 7 * 86_400_000;
  const topics = new Map(loadTopics().map((t) => [t.slug, t]));
  const live = new Set(loadPages().filter((p) => p.status !== 'draft').map((p) => p.slug));
  // A última tentativa também fica fora do git: o registro em data/ vai no resultado do ciclo e, até o aceite, o main não
  // o tem (24/10: a busca do solteirão rodou em 4 ciclos seguidos). Erro de 23/10, quando o registro saiu do estado.
  const tried = readState<Record<string, string>>('gap-search-attempts.json', {});
  const lastOf = (s: string) => Math.max(marked[s]!.last ? Date.parse(marked[s]!.last!) : 0, tried[s] ? Date.parse(tried[s]!) : 0);
  const slug = Object.keys(marked).find((s) => {
    const t = topics.get(s);
    return live.has(s) && t && t.source_ids.every((x) => t.researched_source_ids.includes(x)) && Date.now() - lastOf(s) >= week;
  });
  if (!slug || creditsLeft() < ENRICH_MIN_CREDITS) return false;
  const m = marked[slug]!;
  writeState('gap-search-attempts.json', { ...tried, [slug]: new Date().toISOString() });
  try {
    const r = await discoverSources(slug, newRunId(`${slug}-lacuna`), { maxSearches: 4, maxSources: 5, makerSearches: 4 });
    const added = r.added.filter((a) => a.created).length;
    const tries = added ? 0 : m.tries + 1;
    // 3 semanas sem fonte: desiste e diz o que falta (só um fabricante indicado pelo editor resolve).
    const { [slug]: _, ...rest } = marked;
    writeJson(sf, added || tries < 3 ? { ...marked, [slug]: { ...m, tries, last: new Date().toISOString() } } : rest);
    steps.push(`busca de fonte para a lacuna de ${slug} ("${m.gaps[0]!.slice(0, 80)}"): ${added ? `${added} fonte(s) nova(s); a página é reescrita com elas no enriquecimento` : tries < 3 ? `nada novo; tenta de novo em 7 dias (${tries} de 3)` : 'nada em 3 semanas; a busca para. Só um fabricante ou fonte indicada por você resolve'}`);
    return true;
  } catch (e) {
    steps.push(`busca de fonte para a lacuna de ${slug}: falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}
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
  // Aprovação do editor depois da última mudança vale mais que a regra: não reescreve o que ele aprovou.
  const verdicts = loadVerdicts();
  const approvedByEditor = (p: PageSpec) => verdicts.some((v) => v.slug === p.slug && v.verdict === 'approve' && v.at.slice(0, 10) >= p.updated_at);
  const page = loadPages().find((p) => p.status !== 'draft' && weak(p) && !approvedByEditor(p) && !(tried[p.slug] && Date.now() - Date.parse(tried[p.slug]!) < 7 * 86_400_000));
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

// Parágrafos repetidos em páginas no ar: remove a cópia (determinístico, sem custo de IA). Sai como resultado
// para o editor aceitar, com o antes → depois. Até 3 páginas por ciclo.
// Domínios novos: o motor avalia até 5 por ciclo (~0,1 crédito cada) e decide só com confiança alta; depois revoga
// o que ele aprovou e não rendeu. Tudo vai para o cadastro (aprendizado, entra sozinho) com motivo e desfazer no painel.
async function maintainDomains(steps: string[]): Promise<boolean> {
  if (creditsLeft() < 10) return false;
  try {
    const { evaluateDomains, auditApprovedDomains } = await import('./domains.ts');
    const revoked = auditApprovedDomains();
    const ds = await evaluateDomains({ max: 5 });
    const say = (a: string) => ds.filter((d) => d.action === a).map((d) => d.host);
    const parts = [say('allow').length ? `aprovados ${say('allow').join(', ')}` : '', say('block').length ? `bloqueados ${say('block').join(', ')}` : '', say('unsure').length ? `em dúvida (ficam para você) ${say('unsure').join(', ')}` : '', revoked.length ? `revogados ${revoked.map((r) => r.host).join(', ')}` : ''].filter(Boolean);
    if (parts.length) steps.push(`domínios novos: ${parts.join('; ')}`);
    return ds.length > 0 || revoked.length > 0;
  } catch (e) {
    steps.push(`domínios novos: avaliação falhou (${(e as Error).message.slice(0, 80)})`);
    return false;
  }
}

async function maintainDuplicates(steps: string[]): Promise<boolean> {
  let changed = false;
  for (const p of loadPages().filter((x) => x.status !== 'draft').slice(0)) {
    const d = { title: p.title, description: p.description, verdict: p.verdict, sections: p.sections };
    const r = withoutDuplicates(d as never);
    if (!r.removed.length) continue;
    const spec = { ...p, ...r.draft };
    writeJson(join(DATA, 'pages', `${p.slug}.json`), spec);
    steps.push(`repetição em ${p.slug}: ${r.removed.length} parágrafo(s) que repetiam outro saíram (${r.removed.join(', ')})`);
    changed = true;
    if (steps.filter((x) => x.startsWith('repetição em')).length >= 3) break;
  }
  return changed;
}

// Âncoras dos links internos para páginas no ar que ainda não têm (até 5 por ciclo, ~0,1 crédito cada).
// O site liga a primeira ocorrência delas no texto das outras páginas; o texto não muda.
async function maintainLinks(steps: string[]): Promise<boolean> {
  try {
    // Mesma memória fora do git das imagens: página que já ganhou links num resultado pendente não ganha de novo.
    const recent = readState<Record<string, string>>('links-made.json', {});
    const fresh = (slug: string) => !!recent[slug] && Date.now() - Date.parse(recent[slug]!) < 14 * 86_400_000;
    const pages = loadPages().filter((p) => !fresh(p.slug));
    const done = await ensureAnchors(pages);
    if (done.length) steps.push(`links internos: âncoras para ${done.join(', ')}`);
    // Buscas na Amazon (link com a nossa tag) para página no ar que ainda não tem: ~0,05 crédito cada.
    const amz = await ensureSearchLinks(pages);
    if (amz.length) steps.push(`buscas na Amazon para ${amz.join(', ')}`);
    const now = new Date().toISOString();
    if (done.length || amz.length) writeState('links-made.json', { ...recent, ...Object.fromEntries([...done, ...amz].map((x) => [x, now])) });
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
  // Modelos que a página cita pelo nome, à venda (26/10): uma página por ciclo, cada uma a cada 30 dias; a página
  // recém-aprovada (only) primeiro.
  const citedTried = readState<Record<string, string>>('cited-products-attempts.json', {});
  // Página sem modelos gravados em data/cited-models.json (criado em 26/10) entra antes dos 30 dias: é o que
  // alimenta o link pelo nome no site.
  const { loadCitedModels } = await import('./cited.ts');
  const saved = loadCitedModels().pages;
  const citedNext = only ? [only] : loadPages().filter((p) => p.status !== 'draft' && (!saved[p.slug] || Date.now() - Date.parse(citedTried[p.slug] ?? '1970-01-01') > 30 * 86_400_000)).map((p) => p.slug);
  for (const slug of citedNext.slice(0, 1)) {
    if (creditsLeft() < PRODUCTS_MIN_CREDITS) break;
    citedTried[slug] = new Date().toISOString();
    writeState('cited-products-attempts.json', citedTried);
    try {
      const { findCitedProducts } = await import('./products.ts');
      const r = await findCitedProducts(slug, runId);
      if (r.added.length) changed = true;
      if (r.cited.length) steps.push(`modelos citados em ${slug} (${r.cited.join('; ')}): ${r.added.length ? `à venda: ${r.added.map((a) => a.label).join('; ')}` : 'nenhum anúncio novo do mesmo modelo'}`);
    } catch (e) {
      steps.push(`modelos citados em ${slug}: falhou (${(e as Error).message.slice(0, 80)})`);
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
  if (creditsToday() >= dailyCapFor()) return { status: 'DAILY_CAP', steps: [`teto diário de ${DAILY_CREDIT_CAP} créditos já atingido (ciclo automático)`], credits: 0 };

  // Antes de produzir: se os vereditos do editor mostram limites melhores, a revisão passa a usá-los.
  const cal = calibrate(loadVerdicts());
  if (applyCalibration(cal)) steps.push(`revisão recalibrada: enchimento ≤ ${cal.best.max_filler_ratio}, critérios ≥ ${cal.best.min_criteria} (${cal.best.agree}/${cal.labels} vereditos)`);

  // Manutenção primeiro (todas rodam; qualquer mudança vira ramo de manutenção se não houver pauta).
  const m1 = await maintainProducts(runId, steps);
  const m2 = await maintainImages(steps);
  const m3 = await maintainAudit(runId, steps);
  const m4a = await maintainGapSources(steps);
  const m4 = await maintainEnrich(runId, steps);
  const m5 = await maintainGsc(steps);
  const m6 = await maintainIdeas(steps);
  const m7 = await maintainLinks(steps);
  const m8 = await maintainSummary(runId, steps);
  const m9 = await maintainDuplicates(steps);
  const m10 = await maintainDomains(steps);
  const maintained = m1 || m2 || m3 || m4a || m4 || m5 || m6 || m7 || m8 || m9 || m10;

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
  steps.push(planned.created ? `pauta nova: "${query}" (${planned.topic.questions.length} perguntas)` : `pauta "${query}": nova tentativa (já existia)`);
  // Evidência já verificada em pautas vizinhas entra antes da pesquisa nova (mais completa, mais barata).
  try {
    const re = await reuseEvidence(planned.topic.slug);
    if (re.reused) steps.push(`reuso: ${re.reused} evidência(s) já verificadas de ${re.sources} fonte(s) de pautas vizinhas`);
  } catch (e) {
    steps.push(`reuso: falhou (${(e as Error).message.slice(0, 80)})`);
  }
  const topic = loadTopics().find((t) => t.slug === planned.topic.slug) ?? planned.topic;

  // Cota de busca esgotada no meio da pauta (teto mensal ou plano do Tavily): para limpo, sem adiar a pauta nem
  // registrar "sem fonte" (seria aprendizado falso); a manutenção já feita sai normalmente.
  try {
    if (topic.researched_source_ids.length > 0 && topic.evidence_gaps.length > 0) {
      // Já tentada e reprovada: nova tentativa dirigida às lacunas.
      const r = await improveTopic(topic.slug, runId);
      steps.push(`improve: ${r.status === 'DONE' ? `página ${r.page} (+${r.new_sources} fontes, +${r.new_claims} evidências)` : r.reason}`);
      if (r.status === 'DONE' && r.page === 'NOT_PUBLISHABLE') await autoCorrect(topic.slug, runId, steps);
    } else {
      const d = await discoverSources(topic.slug, runId);
      steps.push(`discover: ${d.added.length} fontes (${d.queries.length} buscas)`);
      // Sem fonte nova, ainda pode haver evidência reaproveitada suficiente: só para se não houver nenhuma fonte.
      if (d.added.length === 0 && loadTopics().find((t) => t.slug === topic.slug)!.source_ids.length === 0) return done({ status: 'STOPPED', slug: topic.slug, query, steps: [...steps, 'sem fontes aceitas'] });
      const r = await research(topic.slug, runId);
      steps.push(`research: ${r.accepted.length} evidências, ${r.unanswered.length} perguntas sem resposta`);
      // Só escreve com regra de escolha sustentada; senão, uma busca dirigida ao que falta e nova checagem; ainda
      // sem regra, a pauta é adiada com o que falta como lacuna (sem gastar redação nem o tempo do editor).
      const gate = await readyOrResearch(topic.slug, runId, steps);
      if (!gate) return done({ status: 'STOPPED', slug: topic.slug, query, steps });
      const p = await buildPage(topic.slug, runId);
      steps.push(`page: ${p.status}${p.status === 'SAFE_STOP' ? ` (${p.reason})` : ''}`);
      // Parou sem página e sem lacuna registrada: as perguntas sem resposta viram lacunas, senão a fila trata
      // a pauta como esgotada e nunca volta a ela (cadeira de escritório, 21/10: 0 evidências, 0 lacunas).
      const t = loadTopic(topic.slug);
      if (p.status === 'SAFE_STOP' && t.evidence_gaps.length === 0 && r.unanswered.length) {
        writeJson(join(DATA, 'topics', `${topic.slug}.json`), TopicBrief.parse({ ...t, evidence_gaps: t.questions.filter((q) => r.unanswered.includes(q.id)).map((q) => q.text) }));
      } else if (p.status === 'SAFE_STOP' && /AUDIT_NOT_CONVERGED/.test(p.reason) && t.evidence_gaps.length === 0 && p.open_issues.length) {
        // Parou na auditoria com as perguntas respondidas (22/10, cadeira ergonômica ou gamer: 55 evidências): o
        // que o auditor não aceitou vira lacuna, e a próxima tentativa vai atrás só disso, sem refazer a pauta.
        writeJson(join(DATA, 'topics', `${topic.slug}.json`), TopicBrief.parse({ ...t, evidence_gaps: p.open_issues.slice(0, 5).map((x) => `Sustentar com fonte ou tirar: ${x.slice(0, 220)}`) }));
      }
      if (p.status === 'PASS') {
        const e = await editPage(p.page, runId);
        steps.push(`edit: ${e.status}`);
      }
      if (p.status === 'NOT_PUBLISHABLE') await autoCorrect(topic.slug, runId, steps);
    }
  } catch (e) {
    if (!(e instanceof SearchError) || e.code !== 'MONTHLY_CAP') throw e;
    steps.push(`cota de busca do Tavily esgotada: a pauta "${query}" espera a cota voltar (nada foi adiado). ${(e as Error).message.slice(0, 120)}`);
    return done(maintained ? { status: 'MAINTENANCE', slug: 'manutencao', steps } : { status: 'STOPPED', slug: topic.slug, query, steps });
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

// Correção automática (22/10, editor: "melhoria contínua"): rascunho que a revisão achou fraco recebe UMA vez a
// correção que o quadro sugeriria (regras "Se você…" das fontes + problemas apontados), sem pesquisa nova. O
// ajuste só grava se a revisão de leitor não piorar. O editor recebe a melhor versão e só decide.
export const AUTO_CORRECT_MIN_CREDITS = 8;
const COHERENCE_FIX_ROUNDS = 2;
export async function autoCorrect(slug: string, runId: string, steps: string[]): Promise<void> {
  try {
    if (creditsLeft() < AUTO_CORRECT_MIN_CREDITS) return;
    const page = loadPages().find((p) => p.slug === slug);
    if (!page || page.status !== 'draft') return;
    const f = join(DATA, 'runs', runId, 'page.json');
    const review = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).review : null;
    const { correctionText, rulesFromNotes } = await import('../board.ts');
    // Coerência (stages/coherence.ts) reprovou: conserta só os blocos apontados, com a frase que ela sugeriu (25/10: a
    // correção pelo texto geral reescreveu a resposta inteira e saiu pior ou caiu na regra de condição repetida).
    // Depois do conserto ela confere de novo; o mesmo erro costuma estar em outro bloco (26/10, nos dois rascunhos
    // de cadeira), então há uma segunda rodada. O cartão mostra o resultado da última conferência.
    const cohOf = (r: unknown) => (((r as { coherence?: { check?: string; ref: string; problem: string; fix: string }[] } | null)?.coherence ?? []).filter((f) => !f.ref.includes('.r')));
    const { adjustWithResearch } = await import('./requests.ts');
    let coh = cohOf(review);
    let msg = '';
    if (!coh.length) {
      const text = correctionText(review, rulesFromNotes(loadTopic(slug).editorial_notes));
      if (!text) return;
      msg = await adjustWithResearch(slug, text, newRunId(`${slug}-autocorrecao`), undefined, { research: false, learn: false });
    }
    for (let round = 0; coh.length && round < COHERENCE_FIX_ROUNDS; round++) {
      const fixRun = newRunId(`${slug}-autocorrecao`);
      const text = coh.map((f) => `No bloco ${f.ref}: ${f.problem.replace(/[.\s]+$/, '')}. Conserto: ${f.fix}`).join(' ');
      const m = await adjustWithResearch(slug, text, fixRun, undefined, { research: false, learn: false, refs: coh.map((f) => f.ref) });
      if (/NÃO salvo|^ajuste não aplicado/.test(m)) { if (!round) msg = m; break; }
      msg = m;
      const fixed = loadPages().find((p) => p.slug === slug);
      const pf = join(DATA, 'runs', fixRun, 'page.json');
      if (!fixed || !existsSync(pf)) break;
      const { auditCoherence } = await import('./coherence.ts');
      const { buildIndex } = await import('../store.ts');
      const idx = buildIndex();
      const c = await auditCoherence(fixed, loadTopic(slug).primary_query, idx.claims, idx.sources);
      const st = JSON.parse(readFileSync(pf, 'utf8'));
      const rv = { ...st.review, coherence: c.findings, ...(c.findings.length ? { publishable: false, reader_problems: [...c.problems, ...(st.review?.reader_problems ?? [])] } : {}) };
      writeFileSync(pf, JSON.stringify({ ...st, review: rv }, null, 2) + '\n');
      steps.push(`coerência depois da correção ${round + 1}: ${c.findings.length ? `ainda ${c.findings.length} problema(s)` : 'limpa'}`);
      // Sem avanço (os mesmos problemas nos mesmos blocos): outra rodada repetiria o conserto que não pegou (26/10,
      // cadeira de tela: a fonte só fala de um modelo; o que resolve é tirar o bloco, decisão do editor).
      const key = (f: { check?: string; ref: string }) => `${f.check}|${f.ref}`;
      const prev = new Set(coh.map(key));
      coh = cohOf(rv);
      if (coh.every((f) => prev.has(key(f)))) break;
    }
    if (!msg) return;
    const note = /^ajuste não aplicado/.test(msg) ? 'não aplicada (a versão corrigida ficou pior; o rascunho original fica)' : /NÃO salvo/.test(msg) ? `não salva (${msg.slice(0, 120)})` : `aplicada${/nota ([\d.]+) de 4; antes ([\d.]+)/.exec(msg) ? ` (nota de leitor ${/nota ([\d.]+) de 4; antes ([\d.]+)/.exec(msg)![2]} → ${/nota ([\d.]+) de 4/.exec(msg)![1]} de 4)` : ''}`;
    steps.push(`correção automática do rascunho: ${note}`);
  } catch (e) {
    steps.push(`correção automática do rascunho: falhou (${(e as Error).message.slice(0, 80)})`);
  }
}

// Checagem do dado que decide antes da redação (readiness.ts). true = pode escrever (regras gravadas como nota
// da pauta para o redator); false = pauta adiada, com o que falta registrado como lacuna.
export async function readyOrResearch(slug: string, runId: string, steps: string[]): Promise<boolean> {
  let r = await decisionReadiness(slug, loadTopic(slug));
  logReadiness(runId, 0, r);
  if (!r.ready) {
    steps.push(`checagem antes de escrever: falta ${r.missing[0]?.slice(0, 140) ?? 'regra de escolha'}; busca dirigida`);
    const t = loadTopic(slug);
    writeJson(join(DATA, 'topics', `${slug}.json`), TopicBrief.parse({ ...t, evidence_gaps: [...new Set([...r.missing, ...r.queries])].slice(0, 5) }));
    // Busca dirigida mais larga antes de desistir: mais fabricantes do tipo, um a um (23/10: "pena ou fibra" foi
    // adiada depois de buscar em 2 dos 18 fabricantes de travesseiro cadastrados).
    const d = await discoverSources(slug, runId, { maxSearches: 5, maxSources: 8, makerSearches: 6 });
    if (d.added.length) await research(slug, runId);
    r = await decisionReadiness(slug, loadTopic(slug));
    logReadiness(runId, 1, r);
    if (!r.ready) {
      const t2 = loadTopic(slug);
      writeJson(join(DATA, 'topics', `${slug}.json`), TopicBrief.parse({ ...t2, evidence_gaps: r.missing.length ? r.missing : t2.evidence_gaps }));
      steps.push(`pauta adiada antes da redação: as evidências não dizem o que escolher (${r.missing[0]?.slice(0, 140) ?? 'sem regra de escolha'})`);
      writeState(DEFERRED_FILE, { ...readState<Record<string, string>>(DEFERRED_FILE, {}), [slug]: new Date().toISOString() });
      return false;
    }
  }
  saveRules(slug, loadTopic(slug), r.rules);
  steps.push(`checagem antes de escrever: ${r.rules.length} regras de escolha sustentadas`);
  return true;
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
