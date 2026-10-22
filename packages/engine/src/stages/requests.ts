import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Basis, checkPage, DEFAULT_THEME, PageSpec, Theme, TopicBrief } from '@bem-apoiado/core';
import { auditDraft } from './audit.ts';
import { discoverSources } from './discover.ts';
import { fixFormWithoutAI, styleIssues } from './page.ts';
import { reviewPage } from './review.ts';
import { withoutDuplicates } from './duplicates.ts';
import { examplesPrompt } from '../exemplars.ts';
import { writeStage } from '../runs.ts';
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
import { learnFromEditor } from '../editor-lessons.ts';
import { catalogNote, formatClaims, writerSystem } from './write.ts';
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
- edit_text: ajustar uma página existente com as fontes que ela já tem: resposta curta, blocos, títulos de seção, tirar repetições, transformar dados em tabela e trocar a descrição que aparece no Google (ex.: "resposta curta mais direta", "faixas de peso em tabela", "descrição para leigo"). Junte num ÚNICO edit_text tudo o que o editor pediu para a mesma página: cada edit_text é uma rodada paga.
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
export async function adjustWithResearch(slug: string, instruction: string, runId: string, fetchImpl?: FetchLike, opts: { research?: boolean; learn?: boolean } = {}): Promise<string> {
  const page = loadPages().find((p) => p.slug === slug);
  if (!page) return `página ${slug} não existe`;
  const doResearch = opts.research ?? true;
  // O pedido pode valer para todas as páginas: vira lição mesmo que o ajuste desta página não salve.
  const learned = opts.learn === false ? null : await learnFromEditor(slug, instruction, fetchImpl).catch(() => null);
  const lessonNote = learned ? `lição nova para todas as páginas: "${learned}"\n→ ` : '';
  const before = loadTopic(slug);
  const qid = `q_ajuste_${createHash('sha1').update(instruction).digest('hex').slice(0, 8)}`;
  const topicFile = join(TOPICS_DIR, `${slug}.json`);
  let fresh = 0;
  let freshIds = new Set<string>();
  if (doResearch) {
    writeJson(topicFile, TopicBrief.parse({
      ...before,
      questions: before.questions.some((q) => q.id === qid) ? before.questions : [...before.questions, { id: qid, text: instruction }],
      evidence_gaps: [instruction],
    }));
    await discoverSources(slug, runId, { maxSearches: 4, maxSources: 5 });
    const r = await research(slug, runId, fetchImpl);
    fresh = r.accepted.filter((a) => a.new).length;
    freshIds = new Set(r.accepted.filter((a) => a.new).map((a) => a.claim_id));
    // A lacuna temporária sai; a pergunta nova fica (as evidências achadas ficam ligadas a ela).
    writeJson(topicFile, TopicBrief.parse({ ...loadTopic(slug), evidence_gaps: before.evidence_gaps }));
  }
  // Sem fonte nova o pedido ainda pode ser uma correção (escopo, atribuição, "exige" → "recomenda"):
  // segue com as evidências que a página já tem.
  const topic = loadTopic(slug);
  const idx = buildIndex();
  // As evidências que a pesquisa deste pedido trouxe, com nome: sem isto o redator recebia ~150 evidências
  // misturadas e "use as novas" não dizia quais (22/10: 10 da XT Racer lidas, nenhuma usada).
  // Também contam as de marca que a página ainda não cita (a pesquisa de um pedido anterior as guardou).
  const cited = new Set([page.verdict, ...page.sections.flatMap((x) => x.blocks.flatMap((b) => (b.kind === 'table' ? b.rows.flatMap((r) => r.cells) : [b])))].flatMap((b) => b.claim_ids).map((id) => idx.claims.get(id)?.source_id).map((sid) => (sid ? idx.sources.get(sid)?.publisher : undefined)));
  const unusedBrand = claimsForTopic(topic, idx.claims.values()).filter((c) => idx.sources.get(c.source_id)?.source_class === 'manufacturer' && !cited.has(idx.sources.get(c.source_id)?.publisher));
  // Revezando por marca (até 20): sem isto a ordem do id decidia quem aparecia.
  const byBrand = new Map<string, typeof unusedBrand>();
  for (const c of unusedBrand) { const k = idx.sources.get(c.source_id)?.publisher ?? ''; byBrand.set(k, [...(byBrand.get(k) ?? []), c]); }
  const turns = [...byBrand.values()];
  const rr = Array.from({ length: Math.max(0, ...turns.map((l) => l.length)) }, (_, i) => turns.map((l) => l[i])).flat().filter((c) => c !== undefined);
  const freshNote = freshList(new Set([...freshIds, ...rr.slice(0, 20).map((c) => c.id)]), idx);
  const blocks = editableBlocks(page);
  const refs = blocks.map((b) => b.ref) as [string, ...string[]];
  const pick = await callJson(
    {
      role: 'extractor',
      system: 'Escolha os blocos da página onde a informação pedida deve entrar ou que o pedido manda alterar (no máximo 5; inclua TODOS os blocos que repetem o problema apontado). Em "headings", só os títulos de seção que o pedido torna errados ou enganosos, com o título novo (até 70 caracteres, sem afirmar fato que o texto não sustenta). "rewrite_summary": true quando o pedido é sobre a resposta curta ou o "Como decidir" COMO UM TODO (linguagem para leigo, tirar jargão, mudar o ponto de vista, foco no comprador), e não sobre um dado pontual.',
      user: `Pedido: ${instruction}\n\nSeções: ${page.sections.map((x) => `${x.id} = "${x.heading}"`).join(' | ')}\n\nBlocos:\n${blocks.map((b) => `- ${b.ref} (${b.label}): ${b.text.slice(0, 140)}`).join('\n')}`,
      schema: z.object({ rewrite_summary: z.boolean().default(false), refs: z.array(z.enum(refs)).min(1).max(5), headings: z.array(z.object({ id: z.enum(page.sections.map((x) => x.id) as [string, ...string[]]), heading: z.string().min(3).max(70) })).default([]) }),
      schemaName: 'pick_blocks',
      maxTokens: 600,
    },
    fetchImpl,
  );
  // Título de seção que o pedido torna enganoso ("O que a NR-17 exige" quando os números são de um anexo).
  const heads = new Map(pick.data.headings.map((h) => [h.id, h.heading.replace(/\s+/g, ' ').trim()]));
  const draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections.map((x) => (heads.has(x.id) ? { ...x, heading: heads.get(x.id)! } : x)) };
  // Pedido sobre o resumo como um todo: a resposta curta e o "Como decidir" são reescritos do zero (o
  // remendo bloco a bloco mantinha as palavras das fontes: "datilo", "Anexo II", 21/10). Resto: remendo.
  const decIdx = draft.sections.findLastIndex((x) => /decidir|escolher/i.test(`${x.id} ${x.heading}`));
  let base = draft as Draft;
  const touched = new Set(pick.data.refs);
  if (pick.data.rewrite_summary && decIdx >= 0) {
    base = await rewriteSummary(base, decIdx, instruction + freshNote, topic, idx, fetchImpl);
    touched.add('verdict');
    // Cada linha de tabela nova é auditada como um bloco (ref secao#i.rN).
    base.sections[decIdx]!.blocks.forEach((b, i) => (b.kind === 'table' ? b.rows.forEach((_, ri) => touched.add(`${base.sections[decIdx]!.id}#${i}.r${ri}`)) : touched.add(`${base.sections[decIdx]!.id}#${i}`)));
  }
  const inSummary = (r: string) => r === 'verdict' || (decIdx >= 0 && r.startsWith(`${draft.sections[decIdx]!.id}#`));
  const rest = pick.data.refs.filter((r) => !(pick.data.rewrite_summary && inSummary(r)));
  const p = rest.length ? await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, base as never, rest.map((ref) => ({ ref, msg: `Pedido do editor: ${instruction}. Use as evidências novas que respondem a isso (cite-as em claim_ids); não afirme nada além dos trechos.${freshNote}` })), fetchImpl) : { data: { patches: [] } };
  let patched = applyPatches(base as never, p.data.patches) as Draft;
  // Regra de forma (parágrafo longo etc.) volta ao redator em vez de derrubar o ajuste (21/10: dois ajustes
  // com pesquisa perdidos por um parágrafo de 130 palavras).
  for (let round = 0; round < FIX_ROUNDS; round++) {
    const st = styleIssues(patched).filter((i) => i.ref && touched.has(i.ref));
    if (!st.length) break;
    const p2 = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, patched as never, st.map((i) => ({ ref: i.ref!, msg: i.msg })), fetchImpl);
    patched = applyPatches(patched as never, p2.data.patches) as Draft;
  }
  const spec = PageSpec.parse({ ...page, ...patched });
  const gate = [...checkPage(spec, idx).map((v) => `${v.where}: ${v.code}`), ...styleIssues(patched).filter((i) => i.ref && touched.has(i.ref)).map((i) => i.msg)];
  if (gate.length) return lessonNote + `ajuste NÃO salvo (regra do site): ${gate.slice(0, 3).join(' | ')}`;
  // Audita a seção inteira, não só os blocos escolhidos: bloco vizinho com o mesmo problema ("A base deve
  // ter 5 pés", do mesmo anexo) também entra na correção.
  const secs = new Set([...touched].map((r) => r.split('#')[0]));
  const scope = new Set([...touched, ...editableBlocks({ ...page, ...patched } as never).map((b) => b.ref).filter((r) => secs.has(r.split('#')[0]))]);
  const fixed = await fixUntilSupported(topic, idx, draft as Draft, patched, scope, fetchImpl);
  // Tabela recusada inteira: bloco que manda "conferir na tabela" ficaria apontando para nada e as faixas
  // sumiriam (22/10, colchão firme ou macio). A seção de decisão e a resposta curta voltam ao original.
  const orphan = (d: Draft) => d.sections.some((sec) => !sec.blocks.some((b) => b.kind === 'table') && sec.blocks.some((b) => b.kind !== 'table' && /tabela (abaixo|acima|a seguir|seguinte)/i.test(b.text)));
  if (orphan(fixed.draft) && !orphan(draft as Draft) && decIdx >= 0) {
    const sid = (draft as Draft).sections[decIdx]!.id;
    fixed.draft.sections = fixed.draft.sections.map((sec) => (sec.id === sid ? structuredClone((draft as Draft).sections[decIdx]!) : sec));
    fixed.draft.verdict = structuredClone((draft as Draft).verdict);
    fixed.kept = fixed.kept.filter((r) => r !== 'verdict' && !r.startsWith(`${sid}#`));
    fixed.dropped.push({ ref: sid, problem: 'o auditor recusou a tabela inteira; a resposta curta e a seção de decisão voltaram ao texto anterior' });
  }
  // Bloco repetido que o ajuste criou sai (22/10, colchão misto ou de espuma: a reescrita deixou a mesma faixa
  // de densidade em 3 blocos). Mesmo corte da criação de página; tabela e resposta curta não entram.
  const dedup = withoutDuplicates(fixed.draft);
  if (dedup.removed.length) fixed.draft = dedup.draft;
  if (!fixed.kept.length) return lessonNote + `ajuste NÃO salvo (o auditor não sustentou nenhum bloco alterado depois de ${FIX_ROUNDS} correções): ${fixed.dropped.map((f) => `${f.ref}: ${f.problem.slice(0, 160)}`).join(' | ')}`;
  const final = PageSpec.parse({ ...page, ...fixed.draft });
  const gate2 = checkPage(final, idx);
  if (gate2.length) return lessonNote + `ajuste NÃO salvo (regra do site): ${gate2.slice(0, 3).map((v) => `${v.where}: ${v.code}`).join(' | ')}`;
  const saved = PageSpec.parse({ ...final, updated_at: new Date().toISOString().slice(0, 10), provenance: { ...page.provenance, run_id: `${page.provenance.run_id}+editor:${runId}` } });
  writeJson(join(PAGES_DIR, `${slug}.json`), saved);
  // Revisão de leitor da versão ajustada (antes ela só existia na criação da página): o cartão do painel
  // mostra as 4 perguntas da página como ficou (22/10: a resposta curta da cadeira deixou de responder ao
  // título depois de um ajuste e ninguém viu). Falha aqui não desfaz o ajuste.
  let reviewNote = '';
  try {
    const rv = await reviewPage(saved, topic, fetchImpl);
    writeStage(runId, 'page', { status: 'EDITOR_ADJUST', review: rv.review });
    const yes = (b: boolean | undefined) => (b === false ? 'não' : 'sim');
    reviewNote = `\nrevisão de leitor: responde à dúvida ${rv.review.answers_primary_query === 'yes' ? 'sim' : rv.review.answers_primary_query === 'partial' ? 'em parte' : 'não'} · resposta rápida ${yes(rv.review.quick_answer)} · leigo ${yes(rv.review.reader_fit)} · leva à compra ${yes(rv.review.purchase_path)}`;
  } catch {
    reviewNote = '\nrevisão de leitor: não rodou (o ajuste vale assim mesmo)';
  }

  return `${lessonNote}texto ajustado em ${slug}${fresh ? ` com ${fresh} evidência(s) nova(s)` : ' com as evidências que a página já tinha'}: ${fixed.kept.join(', ')}${heads.size ? `; título(s) de seção: ${[...heads.values()].map((h) => `"${h}"`).join(', ')}` : ''}` +
    (fixed.dropped.length ? `; ${fixed.dropped.length} bloco(s) voltaram ao texto anterior porque o auditor não sustentou a nova versão (${fixed.dropped.map((f) => `${f.ref}: ${f.problem.slice(0, 120)}`).join(' | ')})` : '') +
    reviewNote;
}

function freshList(ids: Set<string>, idx: ReturnType<typeof buildIndex>): string {
  const list = [...ids].map((id) => idx.claims.get(id)).filter((c) => c !== undefined);
  if (!list.length) return '';
  return `\n\nEvidências NOVAS para a página (trazidas pela pesquisa ou de marca que a página ainda não cita; o editor quer vê-las: use as que respondem ao pedido e, se forem de outra marca, compare as marcas):\n${list.map((c) => `- ${c.id} (${idx.sources.get(c.source_id)?.publisher ?? '?'}): ${c.statement}`).join('\n')}`;
}

async function rewriteSummary(d: Draft, decIdx: number, instruction: string, topic: TopicBrief, idx: ReturnType<typeof buildIndex>, fetchImpl?: FetchLike): Promise<Draft> {
  const claims = claimsForTopic(topic, idx.claims.values());
  const ids = claims.map((c) => c.id) as [string, ...string[]];
  const Text = z.object({ text: z.string().min(20), basis: Basis, claim_ids: z.array(z.enum(ids)) });
  const Cell = z.object({ text: z.string().min(1), claim_ids: z.array(z.enum(ids)) });
  // Tabela opcional (lição do editor: cruzamento de duas grandezas vira tabela) e descrição da página
  // (o texto que aparece no Google): só quando o pedido ou as evidências pedem.
  const Out = z.object({
    verdict: Text,
    blocks: z.array(Text).min(2).max(5),
    table: z.object({ after_block: z.number().int().min(0).max(4), caption: z.string().min(5), columns: z.array(z.string()).min(2).max(4), rows: z.array(z.object({ cells: z.array(Cell) })).min(2).max(10) }).nullable().default(null),
    description: z.string().min(50).max(160).nullable().default(null),
  });
  const sec = d.sections[decIdx]!;
  const others = d.sections.filter((_, i) => i !== decIdx).map((x) => `## ${x.heading}\n${x.blocks.map((b) => (b.kind === 'table' ? `(tabela: ${b.caption})` : `- ${b.text}`)).join('\n')}`).join('\n');
  const r = await callJson(
    {
      role: 'writer',
      system: writerSystem(),
      user:
        `Pedido do editor: ${instruction}\n\nSe as evidências cruzam duas grandezas (peso × densidade, tamanho × medida, perfil × o que conferir), devolva "table" com uma linha por faixa, cada célula com os claim_ids que a sustentam; o título ("caption") diz de quem são os dados (ex.: "Densidade indicada pela Castor para cada faixa de peso"); prefira 2 colunas e NUNCA acrescente coluna que a fonte não traz para todas as linhas (21/10: uma coluna "firmeza típica" inventada derrubou as linhas mais pesadas); senão table=null. "description": a frase que aparece no Google (50 a 160 caracteres, para leigo, sem número que a página não traga), ou null para manter.\n\nReescreva DO ZERO a resposta curta ("verdict") e os blocos da seção "${sec.heading}", seguindo o padrão editorial e o pedido. A resposta curta RESPONDE à pergunta do título em até 2 frases: qual escolher e para quem, com o dado que decide ("Escolha pelo seu peso: até 60 kg…"; "Se você ___, escolha ___"); não é lista do que conferir, não cita norma e não abre com marca (22/10: "Confira na ficha técnica as regulagens…" foi recusada pelo editor). Depois: para quem vai comprar, em palavras do dia a dia, cada bloco de "Como decidir" começando por "Se você..." e dizendo o que conferir. O que é técnico continua nas outras seções da página: não repita, só traduza o que importa para a escolha. Medida que vem de regra de um setor específico entra como REFERÊNCIA para o leitor conferir, não como condição de uso (ex.: "Como referência, uma regra do Ministério do Trabalho para quem trabalha sentado no atendimento por telefone pede assento de 37 a 50 cm do chão: veja se a cadeira alcança isso"). Não comece frase por "Para trabalho em...". Use só as evidências abaixo (claim_ids); não afirme nada além dos trechos.\n\n` +
        catalogNote(topic) + examplesPrompt('writer', { pageType: topic.page_type, exclude: topic.slug }) + `Resposta curta atual: ${d.verdict.text}\n## ${sec.heading} (atual)\n${sec.blocks.map((b) => (b.kind === 'table' ? '' : `- ${b.text}`)).join('\n')}\n\nResto da página (contexto):\n${others.slice(0, 6000)}\n\nEvidências:\n${formatClaims(claims, idx.sources)}`,
      schema: Out,
      schemaName: 'summary_rewrite',
      maxTokens: 3000,
    },
    fetchImpl,
  );
  const out: Draft = structuredClone(d);
  out.verdict = { text: r.data.verdict.text, basis: r.data.verdict.basis, claim_ids: r.data.verdict.claim_ids };
  const paras = r.data.blocks.map((b) => ({ kind: 'paragraph' as const, text: b.text, basis: b.basis, claim_ids: b.claim_ids }));
  const t = r.data.table;
  const blocks: Draft['sections'][number]['blocks'] = [...paras];
  if (t && t.rows.every((row) => row.cells.length === t.columns.length)) blocks.splice(Math.min(t.after_block + 1, blocks.length), 0, { kind: 'table', caption: t.caption, columns: t.columns, rows: t.rows });
  // Sem tabela nova, as tabelas que a seção já tinha ficam (22/10: a D28 perdeu a tabela D28 × D33 numa
  // reescrita do resumo). Voltam na posição em que estavam.
  if (!(t && blocks.some((b) => b.kind === 'table'))) sec.blocks.forEach((b, i) => { if (b.kind === 'table') blocks.splice(Math.min(i, blocks.length), 0, structuredClone(b)); });
  out.sections[decIdx] = { ...sec, blocks };
  if (r.data.description) out.description = r.data.description.replace(/\s+/g, ' ').trim();
  return out;
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
    const style = styleIssues(draft);
    const formOf = (ref: string) => style.filter((i) => i.ref === ref).map((i) => i.msg).join(' ');
    const p = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, draft as never, bad.map((f) => ({ ref: f.ref, msg: `O auditor reprovou: ${f.problem}${f.fix ? ` Conteúdo que as fontes sustentam: "${f.fix}" (use o conteúdo, não a ordem das palavras).` : ''} Mantenha as regras de forma: ${formOf(f.ref) || 'resposta curta começa pela resposta prática, sem abrir com marca, norma ou regulador'}` })), fetchImpl);
    draft = applyPatches(draft as never, p.data.patches.filter((x) => pending.has(x.ref))) as Draft;
  }
  // Depois das correções do auditor, a resposta curta passa de novo pela regra de forma: uma volta de
  // reescrita e auditoria só dela (21/10: a versão sustentada sugerida voltou a abrir com "Segundo a Castor").
  const vStyle = styleIssues(draft).filter((i) => i.ref === 'verdict');
  if (vStyle.length && touched.has('verdict') && !bad.some((f) => f.ref === 'verdict')) {
    const p = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, draft as never, [{ ref: 'verdict', msg: `${vStyle.map((i) => i.msg).join(' ')} Mantenha as mesmas evidências e o mesmo conteúdo; mude só a forma.` }], fetchImpl);
    const cand = applyPatches(draft as never, p.data.patches.filter((x) => x.ref === 'verdict')) as Draft;
    const a = await auditDraft(cand, idx.claims, idx.sources, fetchImpl, new Map(), new Set(['verdict']));
    if (a.findings.every((f) => f.verdict === 'SUPPORTED')) draft = cand;
  }
  // Ainda abre com a marca: a correção sem IA leva a atribuição para o fim da frase e audita (como no ciclo).
  if (touched.has('verdict') && styleIssues(draft).some((i) => i.ref === 'verdict')) {
    const f = fixFormWithoutAI(draft);
    if (f.refs.includes('verdict')) {
      const a = await auditDraft(f.draft, idx.claims, idx.sources, fetchImpl, new Map(), new Set(['verdict']));
      if (a.findings.every((x) => x.verdict === 'SUPPORTED')) draft = { ...draft, verdict: f.draft.verdict };
    }
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
