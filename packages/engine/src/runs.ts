import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readState, RUNS_DIR, writeJson, writeState } from './store.ts';

// Cada execução tem um id ordenável por data; cada estágio grava entrada, saída e uso de tokens.
export function newRunId(topic: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${ts}_${topic}_${randomBytes(2).toString('hex')}`;
}

export function writeStage(runId: string, stage: string, data: unknown): string {
  const path = join(RUNS_DIR, runId, `${stage}.json`);
  writeJson(path, data);
  live({ stage, run: runId });
  return path;
}

// Status ao vivo do ciclo (painel): etapa atual e passos concluídos. Só grava durante um ciclo
// (BEM_CYCLE_LIVE=1, posto pelo cycle.sh) para comandos manuais não sujarem o status.
export interface CycleLive { state: string; started?: string; updated: string; stage?: string; run?: string; steps?: string[] }
export function live(patch: Partial<CycleLive>): void {
  if (process.env.BEM_CYCLE_LIVE !== '1') return;
  try {
    const cur = readState<CycleLive>('cycle-live.json', { state: 'rodando', updated: '' });
    writeState('cycle-live.json', { ...cur, ...patch, updated: new Date().toISOString() });
  } catch {
    /* status é conveniência: nunca derruba o ciclo */
  }
}
