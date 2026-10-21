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
import { DATA, loadPages, loadProducts, loadTopics, readState, ROOT, STATE_DIR, writeState } from '../store.ts';
import type { PageSpec, Product, TopicBrief } from '@bem-apoiado/core';
import { findProductsFromAmazon } from './products.ts';
import { REFRESH_AFTER_DAYS, refreshProducts } from './refresh.ts';
import { discoverSources } from './discover.ts';
import { editPage } from './edit.ts';
import { improveTopic, MAX_IMPROVE_ATTEMPTS } from './improve.ts';
import { buildPage } from './page.ts';
import { planTopic } from './plan.ts';
import { research } from './research.ts';

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
  for (const item of q.items) {
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

export function pagesNeedingProducts(pages: PageSpec[], topics: TopicBrief[], products: Product[], attempts: Record<string, string>, now = new Date()): string[] {
  const kindsOf = new Map(topics.map((t) => [t.slug, t.product_kinds]));
  return pages
    .filter((p) => p.status !== 'draft')
    .filter((p) => {
      const kinds = kindsOf.get(p.slug) ?? [];
      if (kinds.length === 0 || products.some((x) => kinds.includes(x.kind))) return false;
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
  try {
    const r = await research(page.slug, runId, undefined, only);
    if (r.accepted.length === 0) {
      steps.push(`enriquecimento de ${page.slug}: ${only.length} fonte(s) relida(s), nenhuma evidência nova`);
      return true; // a pauta registra as fontes como pesquisadas
    }
    const p = await buildPage(page.slug, runId);
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
  const steps: string[] = [];
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
  const maintained = m1 || m2 || m3 || m4 || m5;

  const query = nextQuery();
  if (!query) {
    if (maintained) return done({ status: 'MAINTENANCE', slug: 'manutencao', steps: [...steps, 'fila sem pauta pendente'] });
    recordCredits(creditsSpent()); // tentativa de produtos sem resultado também gasta
    return { status: 'NOTHING_TO_DO', steps: [...steps, 'fila vazia ou todas as pautas resolvidas/esgotadas'], credits: creditsSpent() };
  }

  const { topic, created } = await planTopic(query);
  steps.push(created ? `pauta planejada (${topic.questions.length} perguntas)` : 'pauta já existia');

  if (topic.researched_source_ids.length > 0 && topic.evidence_gaps.length > 0) {
    // Já tentada e reprovada: nova tentativa dirigida às lacunas.
    const r = await improveTopic(topic.slug, runId);
    steps.push(`improve: ${r.status === 'DONE' ? `página ${r.page} (+${r.new_sources} fontes, +${r.new_claims} evidências)` : r.reason}`);
  } else {
    const d = await discoverSources(topic.slug, runId);
    steps.push(`discover: ${d.added.length} fontes (${d.queries.length} buscas)`);
    if (d.added.length === 0) return done({ status: 'STOPPED', slug: topic.slug, query, steps: [...steps, 'sem fontes aceitas'] });
    const r = await research(topic.slug, runId);
    steps.push(`research: ${r.accepted.length} evidências, ${r.unanswered.length} perguntas sem resposta`);
    const p = await buildPage(topic.slug, runId);
    steps.push(`page: ${p.status}`);
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
