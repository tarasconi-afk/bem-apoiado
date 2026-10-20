import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPage, HumanVerdict, PageSpec, TopicBrief, type ReviewMetrics } from '@bem-apoiado/core';
import { z } from 'zod';
import { buildIndex, DATA, PAGES_DIR, readJsonDir, RUNS_DIR, TOPICS_DIR, writeJson } from './store.ts';

// Veredito humano e calibração da revisão editorial. O editor aprova ou recusa uma página com motivo;
// cada veredito guarda o que a revisão automática mediu. Com vereditos suficientes, os limites da
// regra (enchimento máximo, critérios mínimos) passam a ser os que mais concordam com o editor.

export const FEEDBACK_DIR = join(DATA, 'feedback');
const CALIBRATION_FILE = join(DATA, 'calibration.json');

// Abaixo disso a amostra não autoriza mudar a regra: só mede.
export const MIN_LABELS = 8;

export const Thresholds = z.object({ max_filler_ratio: z.number(), min_criteria: z.number().int() });
export type Thresholds = z.infer<typeof Thresholds>;
export const DEFAULT_THRESHOLDS: Thresholds = { max_filler_ratio: 0.25, min_criteria: 2 };

const Calibration = Thresholds.extend({ labels: z.number().int(), agreement: z.number(), updated_at: z.iso.datetime() });

export function loadThresholds(): Thresholds {
  if (!existsSync(CALIBRATION_FILE)) return DEFAULT_THRESHOLDS;
  return Thresholds.parse(JSON.parse(readFileSync(CALIBRATION_FILE, 'utf8')));
}

export const loadVerdicts = () => readJsonDir(FEEDBACK_DIR, (v) => HumanVerdict.parse(v));

export function ruleDecides(m: ReviewMetrics, t: Thresholds): boolean {
  return m.answers_primary_query !== 'no' && m.concrete_guidance && m.filler_ratio <= t.max_filler_ratio && m.criteria >= t.min_criteria;
}

// Métricas da última revisão da página: as gravadas na própria página ou, em páginas antigas,
// as do registro da execução que a gerou.
export function reviewOf(page: PageSpec): ReviewMetrics | null {
  if (page.provenance.review) return page.provenance.review;
  const runId = page.provenance.run_id.split('+')[0]!;
  const f = join(RUNS_DIR, runId, 'page.json');
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8')).review;
  if (!r) return null;
  return { answers_primary_query: r.answers_primary_query, concrete_guidance: r.concrete_guidance, filler_ratio: r.filler_ratio, criteria: r.decision_criteria.length, rule_publishable: r.publishable };
}

export function recordVerdict(slug: string, verdict: 'approve' | 'reject', reason: string, now = new Date()): HumanVerdict {
  const pageFile = join(PAGES_DIR, `${slug}.json`);
  if (!existsSync(pageFile)) throw new Error(`página ${slug} não existe`);
  const page = PageSpec.parse(JSON.parse(readFileSync(pageFile, 'utf8')));
  if (verdict === 'approve') {
    // O editor decide utilidade; a prova de cada frase continua obrigatória.
    if (page.provenance.audit_verdict !== 'pass') throw new Error('auditoria de evidências não passou: não pode ser aprovada');
    const v = checkPage(page, buildIndex());
    if (v.length) throw new Error(`gate com ${v.length} violação(ões): ${v[0]!.code}`);
  }
  const h = HumanVerdict.parse({ slug, verdict, reason, at: now.toISOString(), run_id: page.provenance.run_id, review: reviewOf(page) });
  writeJson(join(FEEDBACK_DIR, `${h.at.replace(/[-:]/g, '').replace(/\..+/, '')}_${slug}.json`), h);
  if (verdict === 'approve' && page.status === 'draft') writeJson(pageFile, { ...page, status: 'approved' });
  if (verdict === 'reject') {
    if (page.status !== 'draft') writeJson(pageFile, { ...page, status: 'draft' });
    // O motivo vira nota editorial: a próxima tentativa do redator já o recebe.
    const topicFile = join(TOPICS_DIR, `${slug}.json`);
    if (existsSync(topicFile)) {
      const t = TopicBrief.parse(JSON.parse(readFileSync(topicFile, 'utf8')));
      const note = `Editor recusou: ${reason}`;
      if (!t.editorial_notes.includes(note)) writeJson(topicFile, { ...t, editorial_notes: [...t.editorial_notes, note] });
    }
  }
  return h;
}

export interface CalibrationReport {
  labels: number;
  current: Thresholds & { agree: number };
  best: Thresholds & { agree: number };
  disagreements: { slug: string; at: string; human: string; rule: boolean }[];
  apply: boolean;
}

// Busca em grade os limites que mais concordam com o editor. Empate: fica o mais perto do atual
// (a regra só muda quando os dados mostram ganho real).
export function calibrate(verdicts: HumanVerdict[], current: Thresholds = loadThresholds()): CalibrationReport {
  // Só o veredito mais recente de cada execução conta: o editor pode mudar de ideia.
  const latest = new Map<string, HumanVerdict>();
  for (const v of [...verdicts].sort((a, b) => a.at.localeCompare(b.at))) if (v.review) latest.set(`${v.slug}|${v.run_id}`, v);
  const labeled = [...latest.values()];
  const agree = (t: Thresholds) => labeled.filter((v) => ruleDecides(v.review!, t) === (v.verdict === 'approve')).length;
  const dist = (t: Thresholds) => Math.abs(t.max_filler_ratio - current.max_filler_ratio) * 10 + Math.abs(t.min_criteria - current.min_criteria);
  let best = { ...current, agree: agree(current) };
  for (let f = 0.1; f <= 0.5001; f += 0.05) {
    for (let c = 1; c <= 5; c++) {
      const t = { max_filler_ratio: Math.round(f * 100) / 100, min_criteria: c };
      const a = agree(t);
      if (a > best.agree || (a === best.agree && dist(t) < dist(best))) best = { ...t, agree: a };
    }
  }
  const currentAgree = agree(current);
  return {
    labels: labeled.length,
    current: { ...current, agree: currentAgree },
    best,
    disagreements: labeled
      .filter((v) => ruleDecides(v.review!, current) !== (v.verdict === 'approve'))
      .map((v) => ({ slug: v.slug, at: v.at, human: v.verdict, rule: ruleDecides(v.review!, current) })),
    apply: labeled.length >= MIN_LABELS && best.agree > currentAgree,
  };
}

export function applyCalibration(r: CalibrationReport, now = new Date()): boolean {
  if (!r.apply) return false;
  writeJson(CALIBRATION_FILE, Calibration.parse({
    max_filler_ratio: r.best.max_filler_ratio, min_criteria: r.best.min_criteria, labels: r.labels,
    agreement: r.best.agree / r.labels, updated_at: now.toISOString(),
  }));
  return true;
}
