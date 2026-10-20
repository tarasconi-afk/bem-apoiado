import { join } from 'node:path';
import { TopicBrief } from '@bem-apoiado/core';
import { creditsSpent } from '../llm.ts';
import { writeStage } from '../runs.ts';
import { TOPICS_DIR, writeJson } from '../store.ts';
import { discoverSources } from './discover.ts';
import { buildPage, type PageOutcome } from './page.ts';
import { loadTopic, research } from './research.ts';

// Nova tentativa automática de uma pauta reprovada: busca direcionada às lacunas que a revisão
// apontou → pesquisa só as fontes novas → refaz a página → revisa. Para cedo quando não há ganho.
export const MAX_IMPROVE_ATTEMPTS = 2;

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
  writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...topic, improve_attempts: topic.improve_attempts + 1 }));

  const d = await discoverSources(slug, runId, { maxSearches: 6, maxSources: 8 });
  const fresh = d.added.filter((a) => !topic.source_ids.includes(a.source_id));
  if (fresh.length === 0) return stop('NO_NEW_SOURCES: a busca direcionada não achou fonte nova aceita');

  const r = await research(slug, runId);
  const newClaims = r.accepted.filter((a) => a.new).length;
  if (newClaims === 0) return stop(`NO_NEW_EVIDENCE: ${fresh.length} fontes novas sem trecho útil`);

  const p = await buildPage(slug, runId);
  const result: ImproveOutcome = { status: 'DONE', page: p.status, new_sources: fresh.length, new_claims: newClaims, credits: creditsSpent() };
  writeStage(runId, 'improve', result);
  return result;
}
