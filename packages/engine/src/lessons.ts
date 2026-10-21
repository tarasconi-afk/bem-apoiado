import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './store.ts';

// Aprendizado do redator: os erros que o auditor mais apontou nas últimas páginas entram no prompt do redator como "evite isto desde a primeira versão". Menos rodadas de
// remendo = página mais barata e mais páginas aprovadas de primeira. Determinístico, sem chamada de IA.

const LABEL: Record<string, string> = {
  UNSUPPORTED: 'afirmar o que nenhum trecho citado diz',
  OVERSTATED: 'exagerar o trecho (generalizar "sempre/todos", acrescentar condição, número ou intensidade)',
  MISATTRIBUTED: 'apresentar posição de fabricante como fato geral, ou atribuir à fonte errada',
  SAFETY_CLAIM: 'tocar em efeito de saúde',
  FACT_IN_FRAMING: 'pôr fato em frase de transição (basis "framing")',
};

export interface LessonStats { filler: string[]; attempts: number; passed: number; firstRoundIssues: number[]; rounds: number[]; credits: number[]; byType: Map<string, { n: number; examples: string[] }> }

export function auditStats(runsDir = RUNS_DIR, sinceMs = 60 * 86_400_000, now = Date.now()): LessonStats {
  const s: LessonStats = { filler: [], attempts: 0, passed: 0, firstRoundIssues: [], rounds: [], credits: [], byType: new Map() };
  if (!existsSync(runsDir)) return s;
  for (const run of readdirSync(runsDir).sort().reverse()) {
    const m = /^(\d{4})(\d{2})(\d{2})T/.exec(run);
    if (m && now - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) > sinceMs) continue;
    const dir = join(runsDir, run);
    const read = (f: string) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    };
    const page = read('page.json');
    const a0 = read('audit-r0.json');
    if (page?.status) {
      s.attempts++;
      if (page.status === 'PASS') {
        s.passed++;
        if (typeof page.credits === 'number') s.credits.push(page.credits);
      }
      if (typeof page.rounds === 'number') s.rounds.push(page.rounds);
    }
    if (a0?.open_issues) s.firstRoundIssues.push(a0.open_issues.length);
    // Blocos que a revisão marcou como enchimento (texto do último rascunho do run): exemplos para o redator.
    const fillerRefs: string[] = page?.review?.filler_refs ?? [];
    if (fillerRefs.length && s.filler.length < 6) {
      const last = readdirSync(dir).filter((x) => /^write-r\d+\.json$/.test(x)).sort().at(-1);
      const draft = last ? read(last)?.draft : null;
      for (const sec of draft?.sections ?? []) {
        (sec.blocks ?? []).forEach((b: { text?: string }, i: number) => {
          if (b.text && fillerRefs.includes(`${sec.id}#${i}`) && b.text.length < 200 && s.filler.length < 6) s.filler.push(b.text);
        });
      }
    }
    for (const f of readdirSync(dir).filter((x) => /^audit-r\d+\.json$/.test(x))) {
      for (const x of read(f)?.findings ?? []) {
        if (x.verdict === 'SUPPORTED' || !LABEL[x.verdict]) continue;
        const t = s.byType.get(x.verdict) ?? { n: 0, examples: [] };
        t.n++;
        const ex = String(x.problem ?? '').replace(/\s+/g, ' ').trim();
        if (ex && ex.length < 220 && t.examples.length < 2) t.examples.push(ex);
        s.byType.set(x.verdict, t);
      }
    }
  }
  return s;
}

// Bloco curto para o prompt do redator (entrada custa: ~150 tokens no máximo).
export function writerLessons(stats = auditStats()): string {
  const top = [...stats.byType].sort((a, b) => b[1].n - a[1].n).slice(0, 4);
  // Motivo de recusa do editor é da página (vai pelas notas da pauta), não vira lição global.
  if (!top.length) return '';
  return (
    `\n\nErros mais apontados pelo auditor nas últimas páginas (evite desde a primeira versão; cada um custa uma rodada de correção):\n` +
    top.map(([k, v]) => `- ${LABEL[k]} (${v.n}x)${v.examples[0] ? `. Exemplo real: "${v.examples[0]}"` : ''}`).join('\n') +
    (stats.filler.length ? `\nBlocos que a revisão editorial cortou como enchimento (não escreva assim): ${stats.filler.slice(0, 3).map((f) => `"${f}"`).join(' · ')}` : '')
  );
}
