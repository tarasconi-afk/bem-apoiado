import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { checkPage, DEFAULT_THEME, PageSpec, Theme, TopicBrief } from '@bem-apoiado/core';
import { auditDraft } from './audit.ts';
import { discoverSources } from './discover.ts';
import { styleIssues } from './page.ts';
import { research } from './research.ts';
import { applyPatches } from './patch.ts';
import { join } from 'node:path';
import { z } from 'zod';
import { callJson, type FetchLike } from '../llm.ts';
import { recordVerdict } from '../feedback.ts';
import { buildIndex, DATA, loadPages, loadTopics, PAGES_DIR, TOPICS_DIR, writeJson } from '../store.ts';
import { balanceNow, ledger, spendBy } from '../credits.ts';
import { auditStats } from '../lessons.ts';
import { latestSnapshot, pageStats } from '../gsc.ts';
import { trafficSummary } from '../hits.ts';
import { editQueue } from './autopilot.ts';
import { claimsForTopic, type Draft } from './draft-schema.ts';
import { editableBlocks } from './manual-edit.ts';
import { writePatches } from './patch.ts';
import { loadTopic } from './research.ts';

// Pedidos em texto livre pelo painel ("agente"): o modelo traduz o pedido em ações que o motor já sabe
// fazer com as mesmas travas de sempre (fila, refazer com instrução, editar texto com auditoria,
// despublicar, relatório). Mudança de código, visual ou regra NÃO é executada: vira item da lista de pedidos
// para o desenvolvedor (data/dev-requests.json). Tudo o que muda dados vira commit no main pelo painel.

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_topics'), queries: z.array(z.string().min(3)).min(1).max(10) }),
  z.object({ type: z.literal('redo_page'), slug: z.string(), instruction: z.string().min(5) }),
  z.object({ type: z.literal('edit_text'), slug: z.string(), instruction: z.string().min(5) }),
  z.object({ type: z.literal('unpublish'), slug: z.string(), reason: z.string().min(5) }),
  z.object({ type: z.literal('report'), about: z.enum(['gastos', 'qualidade', 'paginas', 'fila', 'visitas']) }),
  z.object({ type: z.literal('theme'), changes: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('developer'), summary: z.string().min(5) }),
]);
const Plan = z.object({ actions: z.array(Action).min(1).max(6), reply: z.string() });

const SYSTEM = `Você é o assistente do painel de um site de guias. Transforme o pedido do editor em ações. Ações possíveis:
- add_topics: pautas novas (dúvidas de decisão, como o leitor busca).
- redo_page: refazer uma página existente com uma instrução (vai para o motor, que reescreve e passa pela auditoria).
- edit_text: ajustar o texto de uma página existente sem mudar as fontes (ex.: "resposta curta mais direta", "frase X mais simples").
- unpublish: tirar uma página do ar (com motivo).
- report: relatório sobre gastos, qualidade, paginas, fila ou visitas (visitas = dados do Google Search Console: cliques, impressões, posição).
- theme: mudar o visual pelo tema (cores em hex, radius_px, text_scale, heading_scale, cta.label, cta.style "cheio"|"contorno", examples_position "inicio"|"meio"|"fim", texts.*). Em "changes", só as chaves que mudam, no mesmo formato do tema atual (objetos aninhados). A mudança vai para prévia e só vale com o aceite do editor.
- developer: o que o tema não cobre (seção ou componente novo, código, regras do site, orçamento, cadastro de domínios, integrações). NÃO tente fazer: resuma para o desenvolvedor.
Use só slugs da lista de páginas. Em "reply", diga em uma ou duas frases o que vai ser feito, sem prometer dado que o motor não tem.`;

const THEME_FILE = join(DATA, 'theme.json');
export const loadTheme = (): Theme => (existsSync(THEME_FILE) ? Theme.parse(JSON.parse(readFileSync(THEME_FILE, 'utf8'))) : DEFAULT_THEME);
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export interface RequestResult { reply: string; done: string[]; failed: string[] }

function report(about: 'gastos' | 'qualidade' | 'paginas' | 'fila' | 'visitas'): string {
  if (about === 'visitas') {
    const snap = latestSnapshot();
    const own = trafficSummary(7);
    const note = own.views || own.clicks ? ` Contador próprio (7 dias): ${own.views} páginas vistas, ${own.clicks} cliques na Amazon${own.pages[0] ? `; mais lida: ${own.pages[0].path} (${own.pages[0].views})` : ''}.` : ' Contador próprio: ainda sem visitas registradas.';
    if (!snap) return `Ainda sem dados do Google Search Console (a primeira leitura chega no ciclo; site novo leva dias a semanas para aparecer).${note}`;
    const st = [...pageStats(snap).values()].sort((a, b) => b.impressions - a.impressions);
    if (!st.length) return `Google Search Console (${snap.start} a ${snap.end}): nenhuma impressão ainda. Normal nas primeiras semanas de um domínio novo.${note}`;
    return `Google (${snap.start} a ${snap.end}): ${st.map((p) => `/${p.slug}/ ${p.clicks} cliques, ${p.impressions} impressões, posição ${p.position.toFixed(1)}`).join('; ')}.${note}`;
  }
  if (about === 'gastos') {
    const led = ledger();
    const by = [...spendBy(led, 7 * 86_400_000)].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
    const b = balanceNow(led);
    return `Gasto em 7 dias: ${by || 'nada registrado'}.${b.estimate !== null ? ` Saldo estimado: ${b.estimate.toFixed(0)} créditos.` : ' Saldo: informe o valor do hPanel no painel.'}`;
  }
  if (about === 'qualidade') {
    const q = auditStats();
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((t, x) => t + x, 0) / xs.length).toFixed(1) : '—');
    return `Últimos 60 dias: ${q.passed}/${q.attempts} tentativas aprovadas; ${avg(q.firstRoundIssues)} problemas por página na 1ª auditoria; ${avg(q.rounds)} rodadas; ${avg(q.credits)} créditos por página aprovada. Erros mais comuns: ${[...q.byType].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.n}`).join(', ')}.`;
  }
  if (about === 'paginas') {
    const p = loadPages();
    return `${p.filter((x) => x.status !== 'draft').length} no ar, ${p.filter((x) => x.status === 'draft').length} em rascunho: ${p.map((x) => `${x.slug} (${x.status === 'draft' ? 'rascunho' : 'no ar'})`).join(', ')}.`;
  }
  const qf = join(DATA, 'queue.json');
  const q = existsSync(qf) ? (JSON.parse(readFileSync(qf, 'utf8')).items as { query: string }[]) : [];
  return `Fila com ${q.length} pautas. Próximas: ${q.slice(0, 8).map((i) => `"${i.query}"`).join(', ')}.`;
}

// Edição de texto por instrução: o modelo escolhe os blocos, o redator reescreve só eles (mesmas fontes) e a
// edição manual confere com o auditor; só grava se sustentado.
export async function handleRequest(text: string, runId: string, fetchImpl?: FetchLike): Promise<RequestResult> {
  const pages = loadPages();
  const plan = await callJson(
    {
      role: 'extractor', system: SYSTEM,
      user: `Tema atual: ${JSON.stringify(loadTheme())}\n\nPáginas (slug: título, situação):\n${pages.map((p) => `- ${p.slug}: ${p.title} (${p.status === 'draft' ? 'rascunho' : 'no ar'})`).join('\n')}\n\nPautas: ${loadTopics().map((t) => t.slug).join(', ')}\n\nPedido do editor: ${text}`,
      schema: Plan, schemaName: 'panel_request', maxTokens: 1500,
    },
    fetchImpl,
  );
  const done: string[] = [];
  const failed: string[] = [];
  const known = new Set(pages.map((p) => p.slug));
  for (const a of plan.data.actions) {
    try {
      if (a.type === 'add_topics') {
        for (const q of a.queries) {
          if (editQueue('add', q)) done.push(`fila: "${q}"`);
          else failed.push(`"${q}" já estava na fila`);
        }
      }
      else if (a.type === 'report') done.push(report(a.about));
      else if (a.type === 'theme') {
        const merged = deepMerge(loadTheme() as unknown as Record<string, unknown>, a.changes);
        const parsed = Theme.safeParse(merged);
        if (!parsed.success) failed.push(`tema: mudança fora do permitido (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
        else {
          writeFileSync(THEME_FILE, JSON.stringify(parsed.data, null, 2) + '\n');
          done.push(`tema alterado (${Object.keys(a.changes).join(', ')}): confira na prévia do resultado em "Esperando sua decisão" e aceite para publicar`);
        }
      } else if (a.type === 'developer') {
        const f = join(DATA, 'dev-requests.json');
        const cur = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
        writeFileSync(f, JSON.stringify([...cur, { at: new Date().toISOString(), request: text, summary: a.summary, status: 'aberto' }], null, 2) + '\n');
        done.push(`anotado para o desenvolvedor: ${a.summary}`);
      } else if (!known.has(a.slug)) failed.push(`página ${a.slug} não existe`);
      else if (a.type === 'redo_page') {
        recordVerdict(a.slug, 'reject', `Pedido do editor: ${a.instruction}`);
        done.push(`${a.slug}: volta ao motor com a instrução "${a.instruction}" (próximos ciclos)`);
      } else if (a.type === 'unpublish') {
        recordVerdict(a.slug, 'reject', a.reason);
        done.push(`${a.slug}: despublicada (${a.reason})`);
      } else if (a.type === 'edit_text') done.push(await adjustWithResearch(a.slug, a.instruction, runId, fetchImpl, { research: false }));
    } catch (e) {
      failed.push(`${a.type}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return { reply: plan.data.reply, done, failed };
}

// Ajuste com pesquisa ("pode pesquisar"): a instrução vira pergunta da pauta, a busca dirigida procura fontes
// sobre ela e a pesquisa lê só as novas; o redator reescreve os blocos escolhidos podendo citar as evidências
// novas; gate + auditoria dos blocos tocados; só grava se tudo for sustentado. Sem fonte nova: diz e não inventa.
export async function adjustWithResearch(slug: string, instruction: string, runId: string, fetchImpl?: FetchLike, opts: { research?: boolean } = {}): Promise<string> {
  const page = loadPages().find((p) => p.slug === slug);
  if (!page) return `página ${slug} não existe`;
  const doResearch = opts.research ?? true;
  const before = loadTopic(slug);
  const qid = `q_ajuste_${createHash('sha1').update(instruction).digest('hex').slice(0, 8)}`;
  const topicFile = join(TOPICS_DIR, `${slug}.json`);
  let fresh = 0;
  if (doResearch) {
    writeJson(topicFile, TopicBrief.parse({
      ...before,
      questions: before.questions.some((q) => q.id === qid) ? before.questions : [...before.questions, { id: qid, text: instruction }],
      evidence_gaps: [instruction],
    }));
    await discoverSources(slug, runId, { maxSearches: 4, maxSources: 5 });
    const r = await research(slug, runId, fetchImpl);
    fresh = r.accepted.filter((a) => a.new).length;
    // A lacuna temporária sai; a pergunta nova fica (as evidências achadas ficam ligadas a ela).
    writeJson(topicFile, TopicBrief.parse({ ...loadTopic(slug), evidence_gaps: before.evidence_gaps }));
  }
  // Sem fonte nova o pedido ainda pode ser uma correção (escopo, atribuição, "exige" → "recomenda"):
  // segue com as evidências que a página já tem.
  const topic = loadTopic(slug);
  const idx = buildIndex();
  const blocks = editableBlocks(page);
  const refs = blocks.map((b) => b.ref) as [string, ...string[]];
  const pick = await callJson(
    {
      role: 'extractor',
      system: 'Escolha os blocos da página onde a informação pedida deve entrar ou que o pedido manda alterar (no máximo 5; inclua TODOS os blocos que repetem o problema apontado). Em "headings", só os títulos de seção que o pedido torna errados ou enganosos, com o título novo (até 70 caracteres, sem afirmar fato que o texto não sustenta).',
      user: `Pedido: ${instruction}\n\nSeções: ${page.sections.map((x) => `${x.id} = "${x.heading}"`).join(' | ')}\n\nBlocos:\n${blocks.map((b) => `- ${b.ref} (${b.label}): ${b.text.slice(0, 140)}`).join('\n')}`,
      schema: z.object({ refs: z.array(z.enum(refs)).min(1).max(5), headings: z.array(z.object({ id: z.enum(page.sections.map((x) => x.id) as [string, ...string[]]), heading: z.string().min(3).max(70) })).default([]) }),
      schemaName: 'pick_blocks',
      maxTokens: 600,
    },
    fetchImpl,
  );
  // Título de seção que o pedido torna enganoso ("O que a NR-17 exige" quando os números são de um anexo).
  const heads = new Map(pick.data.headings.map((h) => [h.id, h.heading.replace(/\s+/g, ' ').trim()]));
  const draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections.map((x) => (heads.has(x.id) ? { ...x, heading: heads.get(x.id)! } : x)) };
  const p = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, draft as never, pick.data.refs.map((ref) => ({ ref, msg: `Pedido do editor: ${instruction}. Use as evidências novas que respondem a isso (cite-as em claim_ids); não afirme nada além dos trechos.` })), fetchImpl);
  const patched = applyPatches(draft as never, p.data.patches);
  const spec = PageSpec.parse({ ...page, ...patched });
  const touched = new Set(pick.data.refs);
  const gate = [...checkPage(spec, idx).map((v) => `${v.where}: ${v.code}`), ...styleIssues(patched).filter((i) => i.ref && touched.has(i.ref)).map((i) => i.msg)];
  if (gate.length) return `ajuste NÃO salvo (regra do site): ${gate.slice(0, 3).join(' | ')}`;
  // Audita a seção inteira, não só os blocos escolhidos: bloco vizinho com o mesmo problema ("A base deve
  // ter 5 pés", do mesmo anexo) também entra na correção.
  const secs = new Set([...touched].map((r) => r.split('#')[0]));
  const scope = new Set([...touched, ...editableBlocks({ ...page, ...patched } as never).map((b) => b.ref).filter((r) => secs.has(r.split('#')[0]))]);
  const fixed = await fixUntilSupported(topic, idx, draft as Draft, patched, scope, fetchImpl);
  if (!fixed.kept.length) return `ajuste NÃO salvo (o auditor não sustentou nenhum bloco alterado depois de ${FIX_ROUNDS} correções): ${fixed.dropped.map((f) => `${f.ref}: ${f.problem.slice(0, 160)}`).join(' | ')}`;
  const final = PageSpec.parse({ ...page, ...fixed.draft });
  const gate2 = checkPage(final, idx);
  if (gate2.length) return `ajuste NÃO salvo (regra do site): ${gate2.slice(0, 3).map((v) => `${v.where}: ${v.code}`).join(' | ')}`;
  writeJson(join(PAGES_DIR, `${slug}.json`), PageSpec.parse({ ...final, updated_at: new Date().toISOString().slice(0, 10), provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+editor:${runId}` } }));
  return `texto ajustado em ${slug}${fresh ? ` com ${fresh} evidência(s) nova(s)` : ' com as evidências que a página já tinha'}: ${fixed.kept.join(', ')}${heads.size ? `; título(s) de seção: ${[...heads.values()].map((h) => `"${h}"`).join(', ')}` : ''}` +
    (fixed.dropped.length ? `; ${fixed.dropped.length} bloco(s) voltaram ao texto anterior porque o auditor não sustentou a nova versão (${fixed.dropped.map((f) => `${f.ref}: ${f.problem.slice(0, 120)}`).join(' | ')})` : '');
}

// Auditoria com correção, como no pipeline da página: bloco reprovado é reescrito pelo redator com o
// problema e a versão sustentada que o auditor propôs, até FIX_ROUNDS vezes. O que ainda não passar volta
// ao texto anterior (o resto do ajuste fica). 21/10: um ajuste da cadeira perdeu tudo por 3 blocos.
const FIX_ROUNDS = 2;
async function fixUntilSupported(topic: TopicBrief, idx: ReturnType<typeof buildIndex>, original: Draft, start: Draft, touched: Set<string>, fetchImpl?: FetchLike): Promise<{ draft: Draft; kept: string[]; dropped: { ref: string; problem: string }[] }> {
  let draft = start;
  let pending = new Set(touched);
  let bad: { ref: string; problem: string; fix: string }[] = [];
  for (let round = 0; round <= FIX_ROUNDS && pending.size; round++) {
    const a = await auditDraft(draft, idx.claims, idx.sources, fetchImpl, new Map(), pending);
    bad = a.findings.filter((f) => f.verdict !== 'SUPPORTED' && pending.has(f.ref));
    pending = new Set(bad.map((f) => f.ref));
    if (!bad.length || round === FIX_ROUNDS) break;
    const p = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, draft as never, bad.map((f) => ({ ref: f.ref, msg: `O auditor reprovou: ${f.problem}${f.fix ? ` Versão que as fontes sustentam: "${f.fix}"` : ''}` })), fetchImpl);
    draft = applyPatches(draft as never, p.data.patches.filter((x) => pending.has(x.ref))) as Draft;
  }
  const restore = bad.map((f) => {
    if (f.ref === 'verdict') return { ref: 'verdict', action: 'replace' as const, text: original.verdict.text, basis: original.verdict.basis, claim_ids: original.verdict.claim_ids };
    const [sec, i] = f.ref.split('#');
    const b = original.sections.find((x) => x.id === sec)?.blocks[Number(i)];
    return b && b.kind !== 'table' ? { ref: f.ref, action: 'replace' as const, text: b.text, basis: b.basis, claim_ids: b.claim_ids } : { ref: f.ref, action: 'remove' as const };
  });
  if (restore.length) draft = applyPatches(draft as never, restore as never) as Draft;
  return { draft, kept: [...touched].filter((r) => !pending.has(r)), dropped: bad };
}
