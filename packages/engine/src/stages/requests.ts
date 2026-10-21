import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callJson, type FetchLike } from '../llm.ts';
import { recordVerdict } from '../feedback.ts';
import { buildIndex, DATA, loadPages, loadTopics } from '../store.ts';
import { balanceNow, ledger, spendBy } from '../credits.ts';
import { auditStats } from '../lessons.ts';
import { latestSnapshot, pageStats } from '../gsc.ts';
import { trafficSummary } from '../hits.ts';
import { editQueue } from './autopilot.ts';
import { claimsForTopic } from './draft-schema.ts';
import { manualEdit, editableBlocks } from './manual-edit.ts';
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
  z.object({ type: z.literal('developer'), summary: z.string().min(5) }),
]);
const Plan = z.object({ actions: z.array(Action).min(1).max(6), reply: z.string() });

const SYSTEM = `Você é o assistente do painel de um site de guias. Transforme o pedido do editor em ações. Ações possíveis:
- add_topics: pautas novas (dúvidas de decisão, como o leitor busca).
- redo_page: refazer uma página existente com uma instrução (vai para o motor, que reescreve e passa pela auditoria).
- edit_text: ajustar o texto de uma página existente sem mudar as fontes (ex.: "resposta curta mais direta", "frase X mais simples").
- unpublish: tirar uma página do ar (com motivo).
- report: relatório sobre gastos, qualidade, paginas, fila ou visitas (visitas = dados do Google Search Console: cliques, impressões, posição).
- developer: qualquer coisa que mude código, visual, regras do site, orçamento, cadastro de domínios ou integrações. NÃO tente fazer: resuma para o desenvolvedor.
Use só slugs da lista de páginas. Em "reply", diga em uma ou duas frases o que vai ser feito, sem prometer dado que o motor não tem.`;

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
async function editByInstruction(slug: string, instruction: string, runId: string, fetchImpl?: FetchLike): Promise<string> {
  const page = loadPages().find((p) => p.slug === slug);
  if (!page) return `página ${slug} não existe`;
  const blocks = editableBlocks(page);
  const refs = blocks.map((b) => b.ref) as [string, ...string[]];
  const pick = await callJson(
    { role: 'extractor', system: 'Escolha os blocos da página que o pedido manda alterar (no máximo 4).', user: `Pedido: ${instruction}\n\nBlocos:\n${blocks.map((b) => `- ${b.ref} (${b.label}): ${b.text.slice(0, 140)}`).join('\n')}`, schema: z.object({ refs: z.array(z.enum(refs)).min(1).max(4) }), schemaName: 'pick_blocks', maxTokens: 400 },
    fetchImpl,
  );
  const topic = loadTopic(slug);
  const idx = buildIndex();
  const draft = { title: page.title, description: page.description, verdict: page.verdict, sections: page.sections };
  const p = await writePatches(topic, claimsForTopic(topic, idx.claims.values()), idx.sources, draft as never, pick.data.refs.map((ref) => ({ ref, msg: `Pedido do editor: ${instruction}. Mantenha as mesmas evidências (claim_ids) e o mesmo basis.` })), fetchImpl);
  const edits: Record<string, string> = {};
  for (const x of p.data.patches) if (x.action === 'replace' && x.text) edits[x.ref] = x.text;
  const r = await manualEdit(page, edits, runId, fetchImpl);
  if (r.status === 'SAVED') return `texto ajustado em ${slug}: ${r.changed.join(', ')}`;
  if (r.status === 'UNCHANGED') return `nada mudou em ${slug}`;
  return `edição em ${slug} NÃO salva (o auditor não sustentou): ${r.problems.map((x) => `${x.ref}: ${x.msg.slice(0, 160)}`).join(' | ')}`;
}

export async function handleRequest(text: string, runId: string, fetchImpl?: FetchLike): Promise<RequestResult> {
  const pages = loadPages();
  const plan = await callJson(
    {
      role: 'extractor', system: SYSTEM,
      user: `Páginas (slug: título, situação):\n${pages.map((p) => `- ${p.slug}: ${p.title} (${p.status === 'draft' ? 'rascunho' : 'no ar'})`).join('\n')}\n\nPautas: ${loadTopics().map((t) => t.slug).join(', ')}\n\nPedido do editor: ${text}`,
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
      else if (a.type === 'developer') {
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
      } else if (a.type === 'edit_text') done.push(await editByInstruction(a.slug, a.instruction, runId, fetchImpl));
    } catch (e) {
      failed.push(`${a.type}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return { reply: plan.data.reply, done, failed };
}
