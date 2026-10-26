import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TopicBrief } from '@bem-apoiado/core';
import { creditsSpent } from '../llm.ts';
import { writeStage } from '../runs.ts';
import { DATA, TOPICS_DIR, writeJson } from '../store.ts';
import { discoverSources } from './discover.ts';
import { buildPage, type PageOutcome } from './page.ts';
import { loadTopic, research } from './research.ts';

// Nova tentativa automática de uma pauta reprovada: busca direcionada às lacunas que a revisão
// apontou → pesquisa só as fontes novas → refaz a página → revisa. Para cedo quando não há ganho.
export const MAX_IMPROVE_ATTEMPTS = 2;

// Novas tentativas valem a pena para este tipo de produto? (26/10: as pautas de cadeira tiveram 10 novas tentativas,
// 1 virou página, ~196 créditos sem página; as fontes de cadeira são fichas de produto, a redação generaliza e a
// auditoria barra rodada após rodada. Colchão: 2 em 2; travesseiro: 1 em 3.) Pelo histórico de data/runs: com 5 ou
// mais tentativas e menos de 15% de páginas, a pauta desse tipo não ganha nova tentativa automática. Volta sozinha se
// uma tentativa der certo e a taxa subir.
export const RETRY_MIN_TRIES = 5;
export const RETRY_MIN_RATE = 0.15;
let retryCache: { at: number; rec: Map<string, { tries: number; wins: number }> } | null = null;
export function retryRecord(): Map<string, { tries: number; wins: number }> {
  if (retryCache && Date.now() - retryCache.at < 60_000) return retryCache.rec;
  const rec = new Map<string, { tries: number; wins: number }>();
  const dir = join(DATA, 'runs');
  for (const run of existsSync(dir) ? readdirSync(dir) : []) {
    const f = join(dir, run, 'improve.json');
    if (!existsSync(f)) continue;
    try {
      const imp = JSON.parse(readFileSync(f, 'utf8')) as { status: string; page?: string };
      if (imp.status !== 'DONE') continue;
      const src = ['research.json', 'discover.json'].map((n) => join(dir, run, n)).find((x) => existsSync(x));
      const slug = src ? (JSON.parse(readFileSync(src, 'utf8')) as { topic?: string }).topic : undefined;
      const tf = slug ? join(TOPICS_DIR, `${slug}.json`) : '';
      if (!slug || !existsSync(tf)) continue;
      const key = kindsKey((JSON.parse(readFileSync(tf, 'utf8')) as { product_kinds: string[] }).product_kinds);
      const r = rec.get(key) ?? { tries: 0, wins: 0 };
      rec.set(key, { tries: r.tries + 1, wins: r.wins + (imp.page === 'PASS' ? 1 : 0) });
    } catch {
      /* execução incompleta: não conta */
    }
  }
  retryCache = { at: Date.now(), rec };
  return rec;
}
const kindsKey = (kinds: string[]) => [...kinds].sort().join(',');
// null = vale tentar; texto = por que não.
export function retryOff(productKinds: string[], rec = retryRecord()): string | null {
  const r = rec.get(kindsKey(productKinds));
  if (!r || r.tries < RETRY_MIN_TRIES || r.wins / r.tries >= RETRY_MIN_RATE) return null;
  return `novas tentativas de pautas deste tipo viraram página ${r.wins} em ${r.tries} vezes`;
}

export type ImproveOutcome =
  | { status: 'STOPPED'; reason: string; credits: number }
  | { status: 'DONE'; page: PageOutcome['status']; new_sources: number; new_claims: number; credits: number };

export async function improveTopic(slug: string, runId: string): Promise<ImproveOutcome> {
  const topic = loadTopic(slug);
  const stop = (reason: string): ImproveOutcome => {
    writeStage(runId, 'improve', { status: 'STOPPED', reason, credits: creditsSpent() });
    return { status: 'STOPPED', reason, credits: creditsSpent() };
  };
  if (topic.evidence_gaps.length === 0) return stop('NO_GAPS: a pauta não tem lacunas registradas');
  if (topic.improve_attempts >= MAX_IMPROVE_ATTEMPTS) return stop(`IMPROVE_LIMIT: ${topic.improve_attempts} tentativas já feitas`);
  const off = retryOff(topic.product_kinds);
  if (off) return stop(`RETRY_OFF: ${off}`);
  writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...topic, improve_attempts: topic.improve_attempts + 1 }));

  const d = await discoverSources(slug, runId, { maxSearches: 6, maxSources: 8 });
  const fresh = d.added.filter((a) => !topic.source_ids.includes(a.source_id));
  if (fresh.length === 0) return stop('NO_NEW_SOURCES: a busca direcionada não achou fonte nova aceita');

  const r = await research(slug, runId);
  const newClaims = r.accepted.filter((a) => a.new).length;
  if (newClaims === 0) return stop(`NO_NEW_EVIDENCE: ${fresh.length} fontes novas sem trecho útil`);

  const steps: string[] = [];
  const { readyOrResearch } = await import('./autopilot.ts');
  if (!(await readyOrResearch(slug, runId, steps))) return stop(`NOT_READY: ${steps.at(-1) ?? 'sem regra de escolha'}`);
  const p = await buildPage(slug, runId);
  const result: ImproveOutcome = { status: 'DONE', page: p.status, new_sources: fresh.length, new_claims: newClaims, credits: creditsSpent() };
  writeStage(runId, 'improve', result);
  return result;
}
