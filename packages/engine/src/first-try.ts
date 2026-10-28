import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './store.ts';
import { failureCause } from './stages/review.ts';
import type { ReviewResult } from './stages/review.ts';

// Aprovação de primeira POR CAUSA (27/10). O número agregado ("29%") não diz o que atacar: as oito causas da
// auditoria daquele dia só apareceram abrindo run por run, à mão. A causa de cada tentativa já está gravada em
// data/runs/<id>/page.json; aqui ela é só lida e contada. Determinístico, sem chamada de IA.
// Runs de ajuste pedido pelo editor (EDITOR_ADJUST) ficam de fora: não são tentativa de página.

export const CAUSES = ['aprovada', 'coerência', 'revisão', 'regra', 'auditoria não convergiu', 'saída inválida do modelo', 'rede', 'orçamento', 'outro'] as const;
export type Cause = (typeof CAUSES)[number];

export interface Attempt { run: string; at: number; cause: Cause; detail: string; slug: string }

// SAFE_STOP traz o motivo em texto; cada prefixo é um defeito diferente e se conserta em lugar diferente.
export function causeOfSafeStop(reason: string): Cause {
  if (/AUDIT_NOT_CONVERGED/.test(reason)) return 'auditoria não convergiu';
  if (/LLM_INVALID_OUTPUT/.test(reason)) return 'saída inválida do modelo';
  if (/LLM_HTTP/.test(reason)) return 'rede';
  if (/BUDGET|teto/.test(reason)) return 'orçamento';
  return 'outro';
}

// A reprovação do juiz já tem frase pronta ("coerência: …", "revisão: …", "regra: …"); aqui vira só a palavra.
export function causeOfReview(review: ReviewResult): { cause: Cause; detail: string } {
  const detail = failureCause(review);
  const head = detail.split(':')[0]!.trim();
  return { cause: (CAUSES as readonly string[]).includes(head) ? (head as Cause) : 'outro', detail };
}

export function attempts(runsDir = RUNS_DIR, sinceMs = 30 * 86_400_000, now = Date.now()): Attempt[] {
  if (!existsSync(runsDir)) return [];
  const out: Attempt[] = [];
  for (const run of readdirSync(runsDir)) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(run);
    if (!m) continue;
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
    if (now - at > sinceMs) continue;
    let d: { slug?: string; status?: string; reason?: string; review?: ReviewResult } | null = null;
    try {
      d = JSON.parse(readFileSync(join(runsDir, run, 'page.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!d?.status || d.status === 'EDITOR_ADJUST') continue;
    // A pauta não sai do nome do run (o do ciclo se chama "…_autopilot_1db0"), e sem ela não dá para medir a
    // aprovação POR TIPO DE PRODUTO — que é o que prevê quem trava (26/10: cadeira 1 em 10, colchão 2 em 2).
    // Runs anteriores a 28/10 não têm o campo e ficam sem pauta.
    const slug = d.slug ?? '';
    if (d.status === 'PASS') out.push({ run, at, cause: 'aprovada', detail: '', slug });
    else if (d.status === 'SAFE_STOP') out.push({ run, at, cause: causeOfSafeStop(d.reason ?? ''), detail: (d.reason ?? '').slice(0, 120), slug });
    else if (d.status === 'NOT_PUBLISHABLE' && d.review) out.push({ run, at, cause: causeOfReview(d.review).cause, detail: causeOfReview(d.review).detail, slug });
    else out.push({ run, at, cause: 'outro', detail: d.status, slug });
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface FirstTry { total: number; passed: number; rate: number | null; byCause: [Cause, number][] }

export function summarize(list: Attempt[]): FirstTry {
  const by = new Map<Cause, number>();
  for (const a of list) by.set(a.cause, (by.get(a.cause) ?? 0) + 1);
  const passed = by.get('aprovada') ?? 0;
  return {
    total: list.length,
    passed,
    rate: list.length ? passed / list.length : null,
    // Só as causas de reprovação, da mais frequente para a menos: é a fila do que consertar.
    byCause: [...by].filter(([c]) => c !== 'aprovada').sort((a, b) => b[1] - a[1]),
  };
}

// Duas janelas DO MESMO TAMANHO para ver se uma correção pegou. O corte é em dias corridos, não por semana do
// calendário: o motor muda no dia em que o commit entra, não na segunda-feira.
// Janela anterior fechada, e não "todo o resto": num projeto de 7 dias, "o resto" eram 7 tentativas contra 57 e
// a comparação dizia que o motor tinha PIORADO, quando só estava comparando tamanhos diferentes.
export function trend(list: Attempt[], days = 7, now = Date.now()): { recent: FirstTry; before: FirstTry } {
  const cut = now - days * 86_400_000;
  const start = now - 2 * days * 86_400_000;
  return { recent: summarize(list.filter((a) => a.at >= cut)), before: summarize(list.filter((a) => a.at >= start && a.at < cut)) };
}
