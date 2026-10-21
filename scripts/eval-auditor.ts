// Avaliação de modelo auditor: audita as páginas aprovadas como estão e com erros plantados.
// Uso (na VPS): BEM_MODEL_AUDITOR=<modelo> npx tsx scripts/eval-auditor.ts
// Mede: concordância nos blocos originais e quantos erros plantados o auditor pega.
import { auditDraft } from '../packages/engine/src/stages/audit.ts';
import { blockRefs } from '../packages/engine/src/stages/draft-schema.ts';
import { creditsSpent, setRunBudget } from '../packages/engine/src/llm.ts';
import { loadClaims, loadPages, loadSources } from '../packages/engine/src/store.ts';

setRunBudget(Number(process.env.EVAL_BUDGET ?? 40));
const claims = new Map(loadClaims().map((c) => [c.id, c]));
const sources = new Map(loadSources().map((s) => [s.id, s]));
type Mut = { kind: string; apply: (t: string) => string | null };
const MUTS: Mut[] = [
  { kind: 'numero', apply: (t) => (/\d+/.test(t) ? t.replace(/\d+/, (n) => String(Number(n) + 7)) : null) },
  { kind: 'atribuicao', apply: (t) => (/Probel/.test(t) ? t.replace(/Probel/g, 'Ortobom') : /Ortobom/.test(t) ? t.replace(/Ortobom/g, 'Probel') : null) },
  { kind: 'sem-fonte', apply: (t) => `${t} Esse tipo de colchão dura pelo menos 15 anos sem perder a forma.` },
  { kind: 'saude', apply: (t) => `${t} Por isso ele ajuda a aliviar dores na coluna.` },
];
const out: Record<string, unknown>[] = [];
for (const page of loadPages().filter((p) => p.status !== 'draft')) {
  const draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections } as never;
  const orig = await auditDraft(draft, claims, sources);
  const okRefs = orig.findings.filter((f) => f.verdict === 'SUPPORTED').map((f) => f.ref);
  // Planta um erro de cada tipo em blocos de texto diferentes (já aprovados na auditoria original).
  const units = blockRefs(draft).filter((u) => okRefs.includes(u.ref) && u.basis !== 'framing');
  const mutated = structuredClone(page);
  const planted: { ref: string; kind: string }[] = [];
  let i = 0;
  for (const m of MUTS) {
    for (; i < units.length; i++) {
      const u = units[i]!;
      const [sid, idx] = u.ref.split('#');
      const sec = mutated.sections.find((s) => s.id === sid);
      const blk = sec?.blocks[Number(idx)];
      if (!blk || blk.kind === 'table') continue;
      const t = m.apply(blk.text);
      if (!t) continue;
      blk.text = t;
      planted.push({ ref: u.ref, kind: m.kind });
      i++;
      break;
    }
  }
  const md = { title: mutated.title, description: mutated.description, verdict: mutated.verdict, sections: mutated.sections } as never;
  const mut = await auditDraft(md, claims, sources, undefined, new Map(), new Set(planted.map((p) => p.ref)));
  const caught = planted.map((p) => ({ ...p, verdict: mut.findings.find((f) => f.ref === p.ref)?.verdict }));
  out.push({ page: page.slug, blocks: orig.findings.length, supported: okRefs.length, verdicts: Object.fromEntries(orig.findings.map((f) => [f.ref, f.verdict])), caught });
}
console.log(JSON.stringify({ model: process.env.BEM_MODEL_AUDITOR ?? 'padrão', credits: creditsSpent(), results: out }, null, 1));
