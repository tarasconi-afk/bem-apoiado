import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageSpec } from '@bem-apoiado/core';
import { loadVerdicts } from './feedback.ts';
import { DATA, loadPages } from './store.ts';

// Páginas aprovadas pelo editor como exemplo de FORMA para o redator e de "publicável" para o juiz (22/10: o
// redator começava cada página do zero e o juiz disse "não publicar" nas 5 páginas que o editor aprovou).
// Só resposta curta e "Como decidir": é o que o editor mais ajusta e o que a busca cita.

const MODELS_FILE = join(DATA, 'model-pages.json');

export function approvedExamples(o: { pageType?: string; exclude?: string; max?: number } = {}, pages: PageSpec[] = loadPages()): PageSpec[] {
  const pinned: string[] = existsSync(MODELS_FILE) ? JSON.parse(readFileSync(MODELS_FILE, 'utf8')).pages : [];
  const approvedAt = new Map<string, string>();
  for (const v of loadVerdicts()) if (v.verdict === 'approve' && (approvedAt.get(v.slug) ?? '') < v.at) approvedAt.set(v.slug, v.at);
  const ok = pages.filter((p) => p.status !== 'draft' && p.slug !== o.exclude && (pinned.includes(p.slug) || approvedAt.has(p.slug)));
  const rank = (p: PageSpec) => [pinned.includes(p.slug) ? 0 : 1, p.page_type === o.pageType ? 0 : 1];
  return ok
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || (approvedAt.get(b.slug) ?? '').localeCompare(approvedAt.get(a.slug) ?? '');
    })
    .slice(0, o.max ?? 2);
}

export function exampleText(p: PageSpec): string {
  const dec = [...p.sections].reverse().find((s) => /decidir|escolh/i.test(`${s.id} ${s.heading}`)) ?? p.sections.at(-1)!;
  const blocks = dec.blocks
    .map((b) => (b.kind === 'table' ? `[tabela: ${b.caption}] ${b.columns.join(' | ')}\n${b.rows.map((r) => r.cells.map((c) => c.text).join(' | ')).join('\n')}` : `- ${b.text}`))
    .join('\n');
  return `### ${p.title}\nResposta curta: ${p.verdict.text}\n## ${dec.heading}\n${blocks}`.slice(0, 1800);
}

export function examplesPrompt(purpose: 'writer' | 'judge', o: { pageType?: string; exclude?: string; max?: number } = {}): string {
  const ex = approvedExamples(o);
  if (!ex.length) return '';
  const head =
    purpose === 'writer'
      ? 'Páginas que o editor aprovou, como exemplo de FORMA (como a resposta curta começa, como o "Como decidir" orienta, quando há tabela). Imite a forma, nunca o conteúdo: dados, marcas e números delas NÃO valem para esta pauta.'
      : 'Páginas que o editor aprovou e publicou: são a referência de "publicável" deste site. Julgue a página nova com o mesmo padrão; ela não precisa ser igual a elas.';
  return `\n\n${head}\n${ex.map(exampleText).join('\n\n')}\n`;
}
