import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, STATE_DIR, writeState } from './store.ts';

// Livro-caixa de créditos de IA: uma linha por chamada, com o valor que o próprio roteador cobrou
// (usage.credits_charged). Estimativa pela tabela de preços só quando a resposta não traz o valor.
// O roteador não expõe saldo: o dono informa o saldo do hPanel no painel e o saldo atual é esse
// valor menos o gasto registrado depois dele.

// Diretório lido na hora da chamada (os testes trocam BEM_STATE_DIR e não podem tocar no livro-caixa real).
const dir = () => process.env.BEM_STATE_DIR ?? STATE_DIR;
const LEDGER = () => join(dir(), 'credits-ledger.jsonl');

export interface LedgerEntry {
  at: string;
  what: string;
  model: string;
  credits: number;
  estimated: boolean;
}

export function recordCharge(what: string, model: string, credits: number, estimated: boolean, now = new Date()): void {
  try {
    mkdirSync(dir(), { recursive: true });
    appendFileSync(LEDGER(), JSON.stringify({ at: now.toISOString(), what, model, credits, estimated } satisfies LedgerEntry) + '\n');
  } catch {
    // Livro-caixa é registro, não trava a execução (ex.: diretório de estado só leitura em teste).
  }
}

export function ledger(): LedgerEntry[] {
  const f = LEDGER();
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as LedgerEntry];
    } catch {
      return [];
    }
  });
}

export interface Balance {
  reported: number;
  reported_at: string;
}

export const setReportedBalance = (reported: number, now = new Date()) => writeState('credit-balance.json', { reported, reported_at: now.toISOString() } satisfies Balance);

export function balanceNow(entries = ledger()): { reported: Balance | null; spentSince: number; estimate: number | null } {
  const b = readState<Balance | null>('credit-balance.json', null);
  if (!b) return { reported: null, spentSince: 0, estimate: null };
  const spentSince = entries.filter((e) => e.at > b.reported_at).reduce((t, e) => t + e.credits, 0);
  return { reported: b, spentSince, estimate: b.reported - spentSince };
}

// Gasto real do dia, do livro-caixa. É diferente do contador do teto diário (llm-usage.json), que só soma os
// ciclos automáticos: em 27/10 o painel mostrava 199 de 250 e o gasto do dia tinha sido 384, porque as ações do
// painel (ajuste, auditoria do site, imagem) ficam fora do teto. Mesmo corte de dia do contador (data UTC).
export function spentToday(entries = ledger(), now = new Date()): number {
  const d = now.toISOString().slice(0, 10);
  return entries.filter((e) => e.at.slice(0, 10) === d).reduce((t, e) => t + e.credits, 0);
}

// Gasto por categoria num período (para o painel e para decidir onde economizar).
export function spendBy(entries: LedgerEntry[], sinceMs: number, now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) if (now - Date.parse(e.at) <= sinceMs) out.set(e.what, (out.get(e.what) ?? 0) + e.credits);
  return out;
}
