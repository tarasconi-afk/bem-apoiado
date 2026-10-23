import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './store.ts';
import type { Suggestion } from './board.ts';

// Modo sombra (23/10, roadmap fase 4 B): a cada decisão do editor no quadro, o painel grava o que o motor sugeria
// naquele momento e o que o editor fez. A concordância diz, com dado e não com impressão, quando o motor pode publicar
// sozinho (só com autorização do dono). Nada aqui publica nada.

export type EditorAction = 'aceitou' | 'corrigiu' | 'recusou';
export interface ShadowEntry {
  at: string;
  card: string; // tipo do cartão: pagina-nova, ajuste-no-ar, manutencao, rascunho
  slug: string;
  ramo: string;
  motor: Suggestion;
  editor: EditorAction;
}

const FILE = () => join(process.env.BEM_STATE_DIR ?? STATE_DIR, 'shadow.jsonl');
export const motorPublishes = (s: Suggestion) => s === 'publicar' || s === 'aplicar' || s === 'aprovar';

export function recordShadow(e: ShadowEntry): void {
  mkdirSync(dirname(FILE()), { recursive: true });
  appendFileSync(FILE(), `${JSON.stringify(e)}\n`);
}

export function loadShadow(): ShadowEntry[] {
  if (!existsSync(FILE())) return [];
  return readFileSync(FILE(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as ShadowEntry];
    } catch {
      return [];
    }
  });
}

// Uma decisão por resultado: clicar de novo (envio que falhou e foi repetido) não conta duas vezes; vale a última.
export function decisions(entries: ShadowEntry[]): ShadowEntry[] {
  const last = new Map<string, ShadowEntry>();
  for (const e of entries) last.set(`${e.ramo}|${e.slug}|${e.motor}`, e);
  return [...last.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export const AUTO_WINDOW = 10;
export const AUTO_MIN_AGREE = 9;
export const AUTO_MIN_DAYS = 14;

export interface ShadowStats {
  total: number;
  window: ShadowEntry[];
  agree: number;
  wouldPublishWrong: ShadowEntry[]; // o motor publicaria, o editor corrigiu ou recusou (o erro que importa)
  wouldHoldWrong: ShadowEntry[]; // o motor seguraria, o editor aceitou como estava (erro conservador)
  spanDays: number;
  ready: boolean;
  missing: string[];
}

// Critério do roadmap: nas últimas 10 decisões, 9 ou mais concordam, nenhuma em que o motor publicaria e o editor não,
// e as 10 cobrem pelo menos 14 dias (não vale uma tarde de cliques).
export function shadowStats(entries: ShadowEntry[], now = new Date()): ShadowStats {
  const all = decisions(entries);
  const window = all.slice(-AUTO_WINDOW);
  const ok = (e: ShadowEntry) => motorPublishes(e.motor) === (e.editor === 'aceitou');
  const agree = window.filter(ok).length;
  const wouldPublishWrong = window.filter((e) => motorPublishes(e.motor) && e.editor !== 'aceitou');
  const wouldHoldWrong = window.filter((e) => !motorPublishes(e.motor) && e.editor === 'aceitou');
  const spanDays = window.length ? (now.getTime() - Date.parse(window[0]!.at)) / 86_400_000 : 0;
  const missing = [
    window.length < AUTO_WINDOW ? `faltam ${AUTO_WINDOW - window.length} decisão(ões) para completar 10` : '',
    window.length >= AUTO_WINDOW && agree < AUTO_MIN_AGREE ? `concordância ${agree} de ${window.length} (precisa de ${AUTO_MIN_AGREE})` : '',
    wouldPublishWrong.length ? `${wouldPublishWrong.length} vez(es) o motor publicaria algo que você corrigiu ou recusou` : '',
    window.length && spanDays < AUTO_MIN_DAYS ? `as decisões cobrem ${Math.floor(spanDays)} dia(s) (precisa de ${AUTO_MIN_DAYS})` : '',
  ].filter(Boolean);
  return { total: all.length, window, agree, wouldPublishWrong, wouldHoldWrong, spanDays, ready: missing.length === 0, missing };
}
