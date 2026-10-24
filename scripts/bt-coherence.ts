// Teste retroativo da auditoria de coerência: roda a checagem em versões de páginas do git, sem gravar nada.
// Uso (na VPS, onde está a chave): npx tsx scripts/bt-coherence.ts <slug>@<rev> ... (ex.: colchao-d28-ou-d33@origin/main)
import { execFileSync } from 'node:child_process';
import { buildIndex } from '../packages/engine/src/store.ts';
import { auditCoherence } from '../packages/engine/src/stages/coherence.ts';
import { loadTopic } from '../packages/engine/src/stages/research.ts';

const idx = buildIndex();
const targets = process.argv.slice(2); // slug@rev
const pool = 4;
const out: string[] = [];
async function one(t: string) {
  const [slug, rev] = t.split('@');
  const page = JSON.parse(execFileSync('git', ['show', `${rev}:data/pages/${slug}.json`], { encoding: 'utf8' }));
  let q = slug!.replace(/-/g, ' ');
  try { q = loadTopic(slug!).primary_query; } catch {}
  const r = await auditCoherence(page, q, idx.claims, idx.sources);
  out.push(`== ${t} (${page.status}) · ${r.usage.input_tokens}+${r.usage.output_tokens} tok\n${r.findings.map((f) => `  [${f.check}] ${f.ref}: ${f.problem}\n     fix: ${f.fix}`).join('\n') || '  (limpa)'}`);
  console.log(out.at(-1));
}
const queue = [...targets];
await Promise.all(Array.from({ length: pool }, async () => { while (queue.length) await one(queue.shift()!); }));
