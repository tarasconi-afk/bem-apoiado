import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_DIR, writeJson } from './store.ts';

// Cada execução tem um id ordenável por data; cada estágio grava entrada, saída e uso de tokens.
export function newRunId(topic: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${ts}_${topic}_${randomBytes(2).toString('hex')}`;
}

export function writeStage(runId: string, stage: string, data: unknown): string {
  const path = join(RUNS_DIR, runId, `${stage}.json`);
  writeJson(path, data);
  return path;
}
