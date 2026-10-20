import { applyCalibration, calibrate, loadVerdicts } from '../feedback.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { creditsSpent } from '../llm.ts';
import { creditsThisMonth } from '../search.ts';
import { DATA, loadPages, loadTopics, ROOT } from '../store.ts';
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

// Teto diário de créditos de IA, somado entre ciclos (contador fora do git).
export const DAILY_CREDIT_CAP = Number(process.env.BEM_DAILY_CREDIT_CAP ?? 150);
const STATE_DIR = process.env.BEM_STATE_DIR ?? (existsSync('/var/lib/bem-apoiado') ? '/var/lib/bem-apoiado' : join(ROOT, '.state'));
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
  status: 'PAGE_APPROVED' | 'PAGE_DRAFT' | 'NOTHING_TO_DO' | 'DAILY_CAP' | 'STOPPED';
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

  const query = nextQuery();
  if (!query) return { status: 'NOTHING_TO_DO', steps: ['fila vazia ou todas as pautas resolvidas/esgotadas'], credits: 0 };

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
  return done({ status, slug: topic.slug, query, steps });
}

// Resumo que o script de ciclo usa como título e corpo do PR.
function writePrSummary(r: CycleResult, runId: string): void {
  const dir = join(ROOT, '.pr');
  mkdirSync(dir, { recursive: true });
  const title = r.status === 'PAGE_APPROVED' ? `Página nova: ${r.query}` : `Tentativa (rascunho): ${r.query}`;
  const body = [
    `**Pauta:** ${r.query}`,
    `**Resultado:** ${r.status === 'PAGE_APPROVED' ? '✅ aprovada pela auditoria e pela revisão editorial: o merge publica' : '📝 rascunho: não será publicada; o merge só guarda o aprendizado (fontes, evidências, lacunas)'}`,
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
