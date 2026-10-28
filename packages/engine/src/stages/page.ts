import { join } from 'node:path';
import { checkPage, PageSpec, TopicBrief } from '@bem-apoiado/core';
import { creditsLeft, creditsSpent, LlmError, type FetchLike } from '../llm.ts';
import { newRunId } from '../runs.ts';
import { MODELS } from '../models.ts';
import { writeStage } from '../runs.ts';
import { buildIndex, PAGES_DIR, TOPICS_DIR, writeJson } from '../store.ts';
import { auditDraft, type AuditCache, type AuditFinding } from './audit.ts';
import { blockRefs, claimsForTopic, selectClaims, type Draft } from './draft-schema.ts';
import { duplicateBlocks, withoutDuplicates } from './duplicates.ts';
import { attributeSingleSource, decisionLast } from './structure.ts';
import { applyPatches, refFromWhere, writePatches, type Issue } from './patch.ts';
import { loadTopic } from './research.ts';
import { reviewMetrics, reviewPage, type ReviewResult } from './review.ts';
import { auditCoherence, CHECK_LABEL, problemText, type CoherenceFinding } from './coherence.ts';
// BEM_COHERENCE=0 desliga a auditoria de coerência (para comparar custo ou resultado).
const COHERENCE = process.env.BEM_COHERENCE !== '0';
import { loadThresholds } from '../feedback.ts';
import { applyEdits } from './edit.ts';
import { writeDraft } from './write.ts';

const MAX_FIX_ROUNDS = 3;
// Coerência (página inteira) antes da revisão: quantas vezes o redator remenda o que ela apontou (27/10: das 15
// páginas reprovadas na revisão desde 20/10, 4 eram só coerência, todas com o juiz dando 4 de 4, e a correção
// automática depois do fato, sem as evidências à mão, não fechava).
const COHERENCE_FIX_ROUNDS = 1;
// Rodadas a mais, liberadas uma a uma só enquanto a anterior tiver DIMINUÍDO o número de achados (28/10).
const COHERENCE_EXTRA_ROUNDS = 2;

// 28/10: "travesseiro NASA" tinha 2 achados de coerência, a única rodada consertou 1 e a página virou rascunho
// pelo outro, com o juiz dando 4 de 4. A rodada extra só é liberada com progresso comprovado: enquanto o número
// de achados cair, vale pagar outra (~1 a 2 créditos). Página que não melhora para onde parava antes, que é a
// trava contra rodar de graça.
export function keepFixingCoherence(rodadasFeitas: number, antes: number, depois: number): boolean {
  if (depois === 0) return false;
  if (rodadasFeitas >= COHERENCE_FIX_ROUNDS + COHERENCE_EXTRA_ROUNDS) return false;
  return rodadasFeitas < COHERENCE_FIX_ROUNDS || depois < antes;
}
// Até quantos blocos sem prova a página pode perder no fim (por remoção) e ainda seguir para a revisão.
const SALVAGE_MAX = 3;
const MIN_CLAIMS = 8;

export type PageOutcome =
  | { status: 'PASS'; rounds: number; page: PageSpec; usage: Usage; review: ReviewResult }
  | { status: 'NOT_PUBLISHABLE'; rounds: number; page: PageSpec; usage: Usage; review: ReviewResult }
  | { status: 'SAFE_STOP'; reason: string; rounds: number; open_issues: string[]; usage: Usage };

interface Usage {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export function toPageSpec(draft: Draft, topic: TopicBrief, runId: string, auditVerdict: 'pass' | 'pending'): PageSpec {
  return PageSpec.parse({
    slug: topic.slug,
    page_type: topic.page_type,
    status: auditVerdict === 'pass' ? 'approved' : 'draft',
    title: draft.title,
    description: draft.description,
    primary_query: topic.primary_query,
    updated_at: new Date().toISOString().slice(0, 10),
    verdict: draft.verdict,
    // "Como decidir" é sempre a última seção (a que o site mostra no topo), mesmo que o redator a ponha antes.
    sections: decisionLast(draft).sections,
    products: [],
    provenance: {
      run_id: runId,
      writer_model: process.env.BEM_MODEL_WRITER ?? MODELS.writer.id,
      auditor_model: auditVerdict === 'pass' ? MODELS.auditor.id : null,
      audit_verdict: auditVerdict,
    },
  });
}

// Regras de forma que não são integridade de evidência, mas também barram a página.
// ref null = problema da página inteira.
export function styleIssues(draft: Draft): Issue[] {
  const out: Issue[] = [];
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let total = 0;
  for (const u of blockRefs(draft)) {
    const n = words(u.text);
    total += n;
    if (u.text.includes('—')) out.push({ ref: u.ref, msg: 'remova o travessão (—).' });
    if (u.basis === 'framing' && n < 6) out.push({ ref: u.ref, msg: 'frase de transição incompleta; escreva uma frase completa ou remova o bloco.' });
    if (!u.ref.includes('.r') && n > 90) out.push({ ref: u.ref, msg: `parágrafo com ${n} palavras; encurte para no máximo 70.` });
  }
  // Tabela de comparação: cada célula traz o dado daquele modelo. Célula que só manda "conferir" não compara
  // nada (22/10, cadeira: "confira no Diretor" em 3 linhas, e na coluna do Diretor o dado de outro modelo).
  for (const sec of draft.sections) sec.blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    b.rows.forEach((r, ri) => {
      if (r.cells.slice(1).some((c) => (/^\s*(confira|verifique|consulte|veja)\b/i.test(c.text) && !/\d/.test(c.text)) || /n[ãa]o (informad|consta|declarad|encontrad)|sem informa[çc][ãa]o/i.test(c.text)))
        out.push({ ref: `${sec.id}#${i}.r${ri}`, msg: 'célula da tabela sem dado ("confira…" ou "não informado"): traga o que a ficha daquele modelo informa, ou tire a linha ou a coluna. Dizer que a fonte não informa também é afirmação sem trecho. Uma coluna é um modelo só.' });
    });
  });
  // Célula de enchimento repetida numa coluna ("Quem busca essa medida", "Medida específica do modelo"): o redator
  // preenche a coluna que não tem fonte com uma frase vazia (24/10, solteirão e tamanhos de travesseiro). Texto sem
  // número, de 3+ palavras, igual em 2+ linhas: tire a coluna ou traga o dado. Nenhuma página no ar tinha isso.
  for (const sec of draft.sections) sec.blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    for (let c = 1; c < b.columns.length; c++) {
      const seen = new Map<string, number>();
      for (const r of b.rows) { const t = r.cells[c]?.text.trim() ?? ''; if (t.split(/\s+/).length >= 3 && !/\d/.test(t)) seen.set(t, (seen.get(t) ?? 0) + 1); }
      const rep = [...seen].find(([, n]) => n >= 2);
      if (rep) out.push({ ref: `${sec.id}#${i}`, msg: `a coluna "${b.columns[c]}" repete "${rep[0]}" em ${rep[1]} linhas, sem dado: traga o que a fonte diz para cada linha ou tire a coluna.` });
    }
  });
  // Linha repetida: mesmo rótulo E mesmo conteúdo, com uma delas só acrescentando a atribuição (28/10, pena de
  // ganso ou fibra: "Enchimento | fibra siliconada 100% poliéster" e, abaixo, "Enchimento | Segundo a Ortobom:
  // fibra siliconada 100% poliéster"). O leitor lê a mesma linha duas vezes; a revisão marcou uma como enchimento
  // e nenhum gate pegava. Exige o conteúdo igual de propósito: numa tabela cuja 1ª coluna é o fabricante, duas
  // linhas "Probel" com modelos diferentes são legítimas (travesseiro para quem dorme de lado).
  const semAtribuicao = (t: string) => fold(t).replace(/^\s*(segundo|conforme|de acordo com)\s+(a|o|os|as)?\s*[^:,]{2,40}[:,]\s*/u, '').replace(/\s+/g, ' ').trim();
  for (const sec of draft.sections) sec.blocks.forEach((b, i) => {
    if (b.kind !== 'table') return;
    const vistas = new Map<string, number>();
    b.rows.forEach((r, ri) => {
      const chave = r.cells.map((c) => semAtribuicao(c.text)).join('\u001f');
      if (!chave.replace(/\u001f/g, '').trim()) return;
      const antes = vistas.get(chave);
      if (antes === undefined) vistas.set(chave, ri);
      else out.push({ ref: `${sec.id}#${i}.r${ri}`, msg: `esta linha diz o mesmo que a linha ${antes + 1} ("${r.cells[0]?.text}"), mudando só a atribuição: deixe uma linha só, com a atribuição, e tire a outra.` });
    });
  });
  // Resposta curta (a frase mais lida da página e a que a busca com IA cita): no máximo 3 frases, começa pela
  // resposta prática e nunca por norma ou regulador. "Trechos citados" é jargão do motor, não do leitor.
  const v = draft.verdict.text.trim();
  const sentences = v.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9])/).filter((x) => x.trim().length > 3).length;
  if (sentences > 3) out.push({ ref: 'verdict', msg: `resposta curta com ${sentences} frases; deixe em até 3, começando pela resposta prática para quem vai comprar.` });
  // Qualquer abertura por atribuição, com marca ou genérica (22/10: "Segundo fabricantes citados, molas
  // ensacadas podem…" passou porque a regra só via nome próprio).
  if (/^([Ss]egundo|[Dd]e acordo com|[Cc]onforme)\s/u.test(v)) out.push({ ref: 'verdict', msg: 'a resposta curta não pode abrir citando a fonte ("Segundo a Ortobom...", "Segundo fabricantes..."): comece pela resposta prática (o que escolher e para quem); a fonte entra depois, se precisar.' });
  if (/^(segundo|conforme|de acordo com|no|na|nos|nas|o|a|os|as)?\s*(inmetro|abnt|nbr|nr[- ]?\d|anvisa|portaria|norma|regulamento|regula[cç][aã]o|trecho|anexo)/i.test(v)) out.push({ ref: 'verdict', msg: 'a resposta curta não pode abrir com norma, regulador ou anexo: comece pelo que o leitor deve escolher ou conferir.' });
  for (const u of blockRefs(draft)) if (/\b(nos|os|segundo os|dos) trechos? citados?\b/i.test(u.text)) out.push({ ref: u.ref, msg: 'não escreva "trechos citados" (é termo do motor): diga quem afirma ("segundo a Ortobom") ou o que não foi informado ("a ficha não informa").' });
  for (const sec of draft.sections) {
    if (sec.blocks.some((b) => b.kind === 'table')) continue;
    sec.blocks.forEach((b, i) => { if (b.kind !== 'table' && /tabela (abaixo|acima|a seguir|seguinte)/i.test(b.text)) out.push({ ref: `${sec.id}#${i}`, msg: 'o texto cita uma tabela que não existe nesta seção: traga a tabela ou escreva os dados no texto.' }); });
  }
  for (const d of duplicateBlocks(draft)) out.push({ ref: d.ref, msg: `repete o bloco ${d.of} (${Math.round(d.overlap * 100)}% das palavras): corte este bloco ou diga só o que ele acrescenta.` });
  if (draft.title.includes('—')) out.push({ ref: null, msg: 'title: remova o travessão (—).' });
  if (total > 1600) out.push({ ref: null, msg: `página com ${total} palavras; encurte para no máximo 1400, cortando o que não ajuda a decidir.` });
  // A decisão fecha a página: "escolher" no meio (ex.: "densidade e como escolher") não conta.
  const last = draft.sections.at(-1);
  if (!last || !/decidir|escolh|antes de comprar|na pr[aá]tica|o que (verificar|conferir)/i.test(last.heading)) out.push({ ref: null, msg: 'a última seção tem de ser "Como decidir", com 2 a 4 orientações condicionais ("se você..., ...") sustentadas pelas evidências.' });
  if (draft.sections.length < 3) out.push({ ref: null, msg: 'a página ficou com menos de 3 seções.' });
  return out;
}

// Regras de decisão (23/10, editor sobre o "solteirão ou viúva": "rasa, pouca informação na tabela, não resolve a
// dúvida como uma dor de quem pesquisa"). Valem na redação e nos trechos que um ajuste toca; não na re-auditoria de
// página antiga (travaria a correção de outra coisa). Testadas nas 14 páginas no ar: pegam o solteirão (sem a medida
// do solteirão, tabela de uma linha, condição repetida), o "firme ou macio" (a resposta não diz o que é firme ou
// macio) e uma "dimensão padronizada" tirada de ficha de produto.
const GENERIC_TITLE_WORDS = new Set(['colchao', 'cadeira', 'travesseiro', 'qual', 'escolher', 'como', 'diferenca', 'vale', 'pena', 'tamanho', 'decidir', 'chutar', 'significam']);
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function decisionIssues(draft: Draft, claimType?: (id: string) => string | undefined): Issue[] {
  const out: Issue[] = [];
  const blockText = (b: Draft['sections'][number]['blocks'][number]) => (b.kind === 'table' ? [b.caption, ...b.columns, ...b.rows.flatMap((r) => r.cells.map((c) => c.text))].join(' ') : b.text);
  // 1) Pergunta "A ou B" no título: a resposta curta ou o "Como decidir" dizem quando escolher CADA opção.
  const head = draft.title.split(':')[0]!;
  const decided = fold(`${draft.verdict.text} ${(draft.sections.at(-1)?.blocks ?? []).map(blockText).join(' ')}`);
  if (/\sou\s/i.test(head)) {
    for (const opt of fold(head).split(/\s+ou\s+/)) {
      const ws = opt.split(/[^a-z0-9]+/).filter((w) => (w.length >= 4 || /\d/.test(w)) && !GENERIC_TITLE_WORDS.has(w));
      if (ws.length && !ws.some((w) => decided.includes(w) || (w.length >= 6 && decided.includes(w.slice(0, -1)))))
        out.push({ ref: 'verdict', msg: `a resposta curta e o "Como decidir" não falam de "${opt.trim()}", uma das opções do título: diga quando escolher cada opção, com o dado da fonte. Se nenhuma fonte trata dela, a página não pode prometer essa comparação.` });
    }
  }
  draft.sections.forEach((sec) => {
    const conds: { ref: string; ws: Set<string> }[] = [];
    sec.blocks.forEach((b, i) => {
      const ref = `${sec.id}#${i}`;
      // 2) Tabela de uma linha não compara nada.
      if (b.kind === 'table' && b.rows.length < 2) out.push({ ref, msg: 'tabela com uma linha só não compara nada: traga uma linha por opção (com o dado de cada uma) ou passe o dado para o texto.' });
      // 3) A mesma condição "Se você…" duas vezes: o leitor lê duas vezes a mesma orientação.
      if (b.kind !== 'table') {
        const m = /^\s*se ([^:]{8,120}?)[:,]/.exec(fold(b.text));
        if (m) {
          const ws = new Set(m[1]!.split(/[^a-z0-9]+/).filter(Boolean));
          const dup = conds.find((c) => [...ws].filter((w) => c.ws.has(w)).length / new Set([...ws, ...c.ws]).size >= 0.6);
          if (dup) out.push({ ref, msg: `repete a condição de ${dup.ref} ("se ${m[1]!.slice(0, 60)}…"): junte os dois blocos ou diga a outra situação.` });
          conds.push({ ref, ws });
        }
      }
      // 4) Dado de modelo específico apresentado como regra geral ("padrão", "oficial") sem norma ou definição.
      if (claimType) {
        const ids = b.kind === 'table' ? b.rows.flatMap((r) => r.cells.flatMap((c) => c.claim_ids)) : b.claim_ids;
        const general = /\bpadr(ao|oes|onizad\w*)\b|\boficia(l|is)\b|\bem geral\b|\btodos? os (colchoes|modelos|fabricantes)\b/.exec(fold(blockText(b)));
        if (ids.length && general && ids.every((id) => ['spec', 'availability'].includes(claimType(id) ?? '')))
          out.push({ ref, msg: `chama de "${general[0]}" um dado que vem só de fichas de produto: diga "declarado nos modelos citados" (com a marca) ou cite norma ou fabricante que defina a regra.` });
      }
    });
  });
  return out;
}

// Conserto de forma sem IA (22/10: o redator recebeu 4 vezes a regra e reescreveu sempre "Segundo a
// Ortobom, ..."): a atribuição que abre a resposta curta vai para o fim da primeira frase; travessão vira
// vírgula. Mesmo conteúdo e mesmas fontes; a resposta volta para o auditor.
// Também para a "versão sustentável" do auditor (27/10, D45: ele propôs "Segundo a Castor, …", o redator copiou,
// a regra de forma barrou a rodada e a página parou sem convergir).
export function verdictFormOf(text: string): string {
  let v = text.trim().replace(/\s*—\s*/g, ', ');
  const m = /^((?:[Ss]egundo|[Dd]e acordo com|[Cc]onforme)\s+(?:(?:a|o|os|as)\s+)?[^,]{2,60}),\s+(.+?)([.!?])(\s|$)([\s\S]*)$/.exec(v);
  if (m) {
    const attrib = m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1);
    const first = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1);
    v = `${first}, ${attrib}${m[3]}${m[5] ? ` ${m[5].trim()}` : ''}`.trim();
  }
  return v;
}

// Transição que só apresenta o próximo assunto, sem dizer nada ao leitor.
export const ANNOUNCE = /^(a seguir|abaixo|logo abaixo|na sequ[êe]ncia|nas pr[óo]ximas|neste (bloco|t[óo]pico)|veja (a seguir|abaixo)|confira (a seguir|abaixo))\b|^(veja|confira|entenda|saiba|compare)\s+(o que|como|quais|as informa|os dados)/i;

export function fixFormWithoutAI(draft: Draft): { draft: Draft; refs: string[] } {
  const out: Draft = structuredClone(draft);
  const refs: string[] = [];
  const nv = verdictFormOf(out.verdict.text);
  if (nv !== out.verdict.text.trim()) { out.verdict = { ...out.verdict, text: nv }; refs.push('verdict'); }
  for (const sec of out.sections) sec.blocks.forEach((b, i) => { if (b.kind !== 'table' && b.text.includes('—')) { b.text = b.text.replace(/\s*—\s*/g, ', '); refs.push(`${sec.id}#${i}`); } });
  // Bloco de transição que só anuncia o que vem depois ("A seguir, veja o que os fabricantes dizem…") não muda nada
  // para quem decide: sai. Só os marcados como "framing" (sem fato nem fonte), então remover não tira informação.
  // 27/10: 4 blocos assim no "colchão D28 ou D33" no ar e 2 na página do protetor, todos com o juiz dando 4 de 4.
  for (const sec of out.sections) {
    const before = sec.blocks.length;
    sec.blocks = sec.blocks.filter((b) => b.kind === 'table' || b.basis !== 'framing' || !ANNOUNCE.test(b.text.trim()));
    if (sec.blocks.length !== before) refs.push(...sec.blocks.map((_, i) => `${sec.id}#${i}`));
  }
  // Tabela com célula sem dado ("não informado nas fontes", "confira na ficha"): a coluna em que isso se repete sai; a
  // linha que ainda ficou sem dado também. Remover nunca acrescenta fato. 27/10, solteirão: o redator devolveu 3 vezes a
  // coluna "Para quem serve" vazia, o gate barrou as 3 rodadas e a página parou sem o auditor nem ter lido a tabela.
  const empty = (t: string) => (/n[ãa]o (informad|consta|declarad|encontrad)|sem informa[çc][ãa]o|^\s*(confira|verifique|consulte|veja)\b/i.test(t) && !/\d/.test(t));
  for (const sec of out.sections) {
    sec.blocks = sec.blocks.filter((b, i) => {
      if (b.kind !== 'table') return true;
      const drop = b.columns.map((_, c) => c > 0 && b.rows.length > 0 && b.rows.filter((r) => empty(r.cells[c]?.text ?? '')).length >= Math.min(b.rows.length, 2));
      const rowsBefore = b.rows.length;
      if (drop.some(Boolean)) {
        b.columns = b.columns.filter((_, c) => !drop[c]);
        b.rows = b.rows.map((r) => ({ cells: r.cells.filter((_, c) => !drop[c]) }));
      }
      b.rows = b.rows.filter((r) => !r.cells.slice(1).some((c) => empty(c.text)));
      if (drop.some(Boolean) || b.rows.length !== rowsBefore) refs.push(`${sec.id}#${i}`, ...b.rows.map((_, ri) => `${sec.id}#${i}.r${ri}`));
      return b.columns.length >= 2 && b.rows.length >= 1;
    });
  }
  out.sections = out.sections.filter((s) => s.blocks.length > 0);
  return { draft: out, refs };
}

// Troca o texto de cada bloco reprovado pela versão sustentada que o auditor propôs, mantendo as fontes e o
// tipo do bloco. Linha de tabela e bloco sem proposta ficam como estão.
export function adoptAuditorFixes(draft: Draft, findings: { ref: string; verdict: string; fix: string }[]): { draft: Draft; refs: string[] } {
  const patches = findings
    .filter((f) => f.verdict !== 'SUPPORTED' && f.fix && f.fix.trim().length >= 15 && !f.ref.includes('.r'))
    .map((f) => {
      const u = blockRefs(draft).find((b) => b.ref === f.ref);
      return u ? { ref: f.ref, action: 'replace' as const, text: f.ref === 'verdict' ? verdictFormOf(f.fix) : f.fix.trim().replace(/\s*—\s*/g, ', '), basis: u.basis as never, claim_ids: u.claim_ids } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return { draft: applyPatches(draft, patches as never), refs: patches.map((p) => p.ref) };
}

const show = (i: Issue) => (i.ref ? `${i.ref}: ${i.msg}` : i.msg);

// Redator em camadas: o barato (Haiku) escreve; se a página não passar (auditoria não converge ou revisão
// reprova), uma segunda tentativa com o Sonnet, se houver orçamento. Avaliação de 21/10 na mesma pauta:
// Haiku 7,8 créditos, Sonnet 24,2, as duas aprovadas com notas de revisão parecidas.
export const ESCALATION_WRITER = 'claude-sonnet-5';
const ESCALATION_MIN_CREDITS = 30;
// Primeira tentativa que já custou isso não ganha a segunda (21/10: base box gastou ~30 no Haiku, com 2
// reservas de Sonnet 4.6 por 524, e mais 14 na escalada; terminou rascunho igual).
const ESCALATION_MAX_FIRST_SPEND = 15;

export async function buildPage(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  const before = creditsSpent();
  const first = await buildPageOnce(slug, runId, fetchImpl);
  const doomed = first.status === 'SAFE_STOP' && /INSUFFICIENT_EVIDENCE|BUDGET/.test(first.reason);
  const costly = creditsSpent() - before > ESCALATION_MAX_FIRST_SPEND;
  // Desligada por padrão (21/10: duas escaladas de 14 e 36,5 créditos terminaram em rascunho ou estouro do
  // teto). Página que não passa fica rascunho e o editor ajusta (2–5 créditos). BEM_ESCALATION=1 religa.
  if (process.env.BEM_ESCALATION !== '1') return first;
  if (first.status === 'PASS' || doomed || costly || process.env.BEM_MODEL_WRITER || creditsLeft() < ESCALATION_MIN_CREDITS) return first;
  const rid = newRunId(`${slug}-escalada`);
  writeStage(runId, 'escalation', { from: MODELS.writer.id, to: ESCALATION_WRITER, first: first.status, run: rid });
  process.env.BEM_MODEL_WRITER = ESCALATION_WRITER;
  try {
    return await buildPageOnce(slug, rid, fetchImpl);
  } finally {
    delete process.env.BEM_MODEL_WRITER;
  }
}

async function buildPageOnce(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  try {
    return await buildPageInner(slug, runId, fetchImpl);
  } catch (e) {
    // Falha de LLM (crédito, rede, saída inválida) vira parada segura com relatório, nunca página parcial.
    if (!(e instanceof LlmError)) throw e;
    const reason = `LLM_${e.code}: ${e.message.slice(0, 300)}`;
    writeStage(runId, 'page', { slug, status: 'SAFE_STOP', reason, credits: creditsSpent() });
    return { status: 'SAFE_STOP', reason, rounds: 0, open_issues: [], usage: { input_tokens: 0, output_tokens: 0, calls: 0 } };
  }
}

async function buildPageInner(slug: string, runId: string, fetchImpl?: FetchLike): Promise<PageOutcome> {
  const topic = loadTopic(slug);
  const idx = buildIndex();
  const claims = selectClaims(topic, idx.claims.values(), (id) => idx.sources.get(id)?.source_class);
  const usage: Usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  const add = (u: { input_tokens: number; output_tokens: number }, calls = 1) => {
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.calls += calls;
  };
  if (claims.length < MIN_CLAIMS) {
    return { status: 'SAFE_STOP', reason: `INSUFFICIENT_EVIDENCE (${claims.length})`, rounds: 0, open_issues: [], usage };
  }

  const cache: AuditCache = new Map();
  // Fonte de cada evidência, para a atribuição por código (fabricante único sem nome no texto).
  const sourceOf = (id: string) => { const src = idx.sources.get(idx.claims.get(id)?.source_id ?? ''); return src ? { publisher: src.publisher, source_class: src.source_class } : undefined; };

  // Coerência apontou blocos: o redator remenda só eles (com todas as evidências), forma e gate conferem, o auditor
  // julga só os blocos tocados. Qualquer recusa devolve null e o rascunho fica como estava.
  const fixCoherence = async (d: Draft, findings: CoherenceFinding[], stage: string): Promise<Draft | null> => {
    const have = new Set(blockRefs(d).map((u) => u.ref));
    const issues: Issue[] = findings.filter((f) => have.has(f.ref)).map((f) => ({ ref: f.ref, msg: `${CHECK_LABEL[f.check]}: ${f.problem.replace(/[.\s]+$/, '')}. Conserto: ${f.ref === 'verdict' ? verdictFormOf(f.fix) : f.fix}` }));
    if (!issues.length) return null;
    const p = await writePatches(topic, claims, idx.sources, d, issues, fetchImpl);
    add(p.usage);
    const cand = attributeSingleSource(fixFormWithoutAI(decisionLast(applyPatches(d, p.data.patches))).draft, sourceOf).draft;
    // Remoção desloca a numeração: audita as seções tocadas inteiras (e a resposta curta, se mudou).
    const secs = new Set(issues.map((i) => i.ref!.split('#')[0]!));
    const touched = blockRefs(cand).map((u) => u.ref).filter((r) => secs.has(r.split('#')[0]!));
    const gate = [...checkPage(toPageSpec(cand, topic, runId, 'pending'), idx).map((v) => ({ ref: refFromWhere(v.where), msg: `${v.code} ${v.detail}` })), ...styleIssues(cand), ...decisionIssues(cand, (id) => idx.claims.get(id)?.claim_type)];
    const blocked = gate.filter((i) => i.ref === null || touched.includes(i.ref));
    if (blocked.length || !touched.length) {
      writeStage(runId, stage, { patches: p.data.patches, kept: false, blocked: blocked.map(show) });
      return null;
    }
    const a = await auditDraft(cand, idx.claims, idx.sources, fetchImpl, cache, new Set(touched));
    add(a.usage, a.usage.calls);
    const still = a.findings.filter((f) => f.verdict !== 'SUPPORTED');
    writeStage(runId, stage, { patches: p.data.patches, kept: still.length === 0, audited: touched, still: still.map((f) => `${f.ref}: ${f.verdict}`) });
    return still.length ? null : cand;
  };

  // 3) Revisão editorial e gravação: igual para página convergida e para página salva por remoção.
  const finish = async (final: Draft, rounds: number): Promise<PageOutcome> => {
    let draft = final;
    // 3a) Coerência da página inteira ANTES da revisão, ainda com o redator e as evidências à mão: o que ela
    // apontar vira remendo nos blocos apontados, auditado e conferido de novo (COHERENCE_FIX_ROUNDS vezes).
    let coherence: CoherenceFinding[] = [];
    if (COHERENCE) {
      let c = await auditCoherence(toPageSpec(draft, topic, runId, 'pass'), topic.primary_query, idx.claims, idx.sources, fetchImpl);
      add(c.usage, c.usage.calls);
      writeStage(runId, 'coherence', { findings: c.findings, usage: c.usage });
      // Rodada extra SÓ com progresso comprovado: 28/10, "travesseiro NASA" tinha 2 achados, a rodada consertou 1
      // e parou com o outro aberto; o juiz dava 4 de 4 e a página virou rascunho por um título de seção. Enquanto
      // cada rodada diminuir o número de achados, vale pagar outra (~1 a 2 créditos). Página que não melhora na
      // primeira continua parando na primeira, que é a trava contra ficar rodando de graça.
      for (let i = 0; c.findings.length; i++) {
        const antes = c.findings.length;
        const fixed = await fixCoherence(draft, c.findings, `coherence-fix-${i + 1}`);
        if (!fixed) break;
        draft = fixed;
        c = await auditCoherence(toPageSpec(draft, topic, runId, 'pass'), topic.primary_query, idx.claims, idx.sources, fetchImpl);
        add(c.usage, c.usage.calls);
        writeStage(runId, `coherence-${i + 1}`, { findings: c.findings, usage: c.usage });
        if (!keepFixingCoherence(i + 1, antes, c.findings.length)) break;
      }
      coherence = c.findings;
    }
    const afterCoherence = draft;
    // 3) Revisão editorial: correta não basta, tem de servir. Reprovada fica como rascunho.
    let passed = toPageSpec(draft, topic, runId, 'pass');
    let rv = await reviewPage(passed, topic, fetchImpl);
    add(rv.usage);
    // Quase lá (orienta, tem critérios, enchimento até 45%): corta os blocos que a própria revisão
    // apontou como enchimento e revisa de novo. Remover nunca acrescenta fato; uma vez só.
    const r0 = rv.review;
    if (!r0.publishable && r0.concrete_guidance && r0.answers_primary_query !== 'no' && r0.decision_criteria.length >= loadThresholds().min_criteria && r0.filler_ratio <= 0.45 && r0.filler_refs.length > 0) {
      const trimmed = applyEdits(draft, r0.filler_refs.map((ref) => ({ ref, action: 'remove' as const, reason: 'enchimento apontado pela revisão' }))).draft;
      const candidate = toPageSpec(trimmed, topic, runId, 'pass');
      if (checkPage(candidate, idx).length === 0 && styleIssues(trimmed).length === 0) {
        const rv2 = await reviewPage(candidate, topic, fetchImpl);
        add(rv2.usage);
        writeStage(runId, 'trim', { removed: r0.filler_refs, before: r0, after: rv2.review });
        draft = trimmed;
        passed = candidate;
        rv = rv2;
      }
    }
    // 4) Coerência que sobrou reprova (24/10: as 3 páginas novas da noite tiveram 4 de 4 e o editor corrigiu as 3):
    // vira o pedido de correção do cartão e da correção automática. O corte de enchimento só remove blocos; se
    // removeu, confere a coerência de novo (tirar um bloco pode deixar um caso sem orientação).
    if (COHERENCE && rv.review.publishable && draft !== afterCoherence && !coherence.length) {
      const c = await auditCoherence(passed, topic.primary_query, idx.claims, idx.sources, fetchImpl);
      add(c.usage, c.usage.calls);
      writeStage(runId, 'coherence-after-trim', { findings: c.findings, usage: c.usage });
      coherence = c.findings;
    }
    if (rv.review.publishable && coherence.length) {
      const problems = coherence.map(problemText);
      rv = { ...rv, review: { ...rv.review, publishable: false, coherence, reader_problems: [...problems, ...(rv.review.reader_problems ?? [])], missing: [...problems.map((x) => `Para o leitor leigo: ${x}`), ...rv.review.missing] } };
    }
    const reviewed: PageSpec = { ...passed, provenance: { ...passed.provenance, review: reviewMetrics(rv.review) } };
    const page: PageSpec = rv.review.publishable ? reviewed : { ...reviewed, status: 'draft' };
    writeJson(join(PAGES_DIR, `${slug}.json`), page);
    // A pauta guarda o que faltou: é a entrada da próxima tentativa (improve).
    writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...loadTopic(slug), evidence_gaps: rv.review.publishable ? [] : rv.review.missing }));
    const status = rv.review.publishable ? 'PASS' : 'NOT_PUBLISHABLE';
    writeStage(runId, 'page', { slug, status, rounds: rounds, usage, credits: creditsSpent(), review: rv.review });
    return { status, rounds: rounds, page, usage, review: rv.review };
  };

  let draft: Draft | null = null;
  let issues: Issue[] = [];
  let lastFindings: AuditFinding[] = [];
  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    // Primeira rodada e problema de página inteira: reescrita completa. Senão: remendos só nos blocos
    // apontados; o que já foi aprovado fica trancado, então cada rodada só pode reduzir os problemas.
    if (!draft || issues.some((i) => i.ref === null)) {
      const w = await writeDraft(topic, claims, idx.sources, draft ? { previous: draft, issues: issues.map(show) } : null, fetchImpl);
      add(w.usage);
      // "Como decidir" para o fim já aqui, antes de qualquer checagem (22/10, cadeira para obeso: o redator o pôs
      // em 1º nas 4 rodadas, o auditor aprovou todos os blocos e a página parou só pela regra "a última seção tem
      // de ser Como decidir"; a reordenação só acontecia na gravação, depois da checagem que travou).
      // Forma sem IA já aqui, em toda rodada (e não só depois do laço): a rodada não se perde por "Segundo a X, …"
      // na resposta curta (27/10, D45: a 3ª rodada parou no gate por isso e a página não convergiu).
      draft = attributeSingleSource(fixFormWithoutAI(decisionLast(w.data)).draft, sourceOf).draft;
      writeStage(runId, `write-r${round}`, { mode: 'full', draft, issues_in: issues, usage: w.usage, model: w.model });
    } else {
      const p = await writePatches(topic, claims, idx.sources, draft, issues, fetchImpl);
      add(p.usage);
      draft = attributeSingleSource(fixFormWithoutAI(decisionLast(applyPatches(draft, p.data.patches))).draft, sourceOf).draft;
      writeStage(runId, `write-r${round}`, { mode: 'patch', patches: p.data.patches, draft, issues_in: issues, usage: p.usage });
    }

    // 1) Gate determinístico primeiro: é grátis e pega o grosso.
    const gate: Issue[] = checkPage(toPageSpec(draft, topic, runId, 'pending'), idx).map((v) => ({
      ref: refFromWhere(v.where),
      msg: `${v.code} ${v.detail}`,
    }));
    issues = [...gate, ...styleIssues(draft), ...decisionIssues(draft, (id) => idx.claims.get(id)?.claim_type)];
    let findings: AuditFinding[] = [];
    // 2) Auditoria semântica só quando o gate passa (não paga auditor para rascunho quebrado).
    if (issues.length === 0) {
      const a = await auditDraft(draft, idx.claims, idx.sources, fetchImpl, cache);
      add(a.usage, a.usage.calls);
      findings = a.findings;
      lastFindings = findings;
      issues = findings
        .filter((f) => f.verdict !== 'SUPPORTED')
        .map((f) => ({ ref: f.ref, msg: `${f.verdict}. ${f.problem}${f.fix ? ` Versão sustentável: ${f.ref === 'verdict' ? verdictFormOf(f.fix) : f.fix}` : ''}` }));
    }
    writeStage(runId, `audit-r${round}`, { findings, open_issues: issues });

    if (issues.length === 0) return finish(draft, round + 1);
  }
  // Não convergiu: adota a versão que o próprio auditor disse que as fontes sustentam (mesmas fontes do
  // bloco) e audita só esses blocos. 22/10: a cadeira gamer parou duas vezes com 6 exageros que tinham, cada
  // um, a versão sustentada pronta; o redator reescrevia e errava de novo.
  if (draft && issues.length > 0) {
    const adopted = adoptAuditorFixes(draft, lastFindings);
    if (adopted.refs.length) {
      // Bloco que a adoção deixou repetido sai (remoção); resposta curta fora da forma ganha um remendo só de
      // forma, com as mesmas fontes, e volta para a auditoria junto com os outros.
      const secs = new Set(adopted.refs.filter((r) => r !== 'verdict').map((r) => r.split('#')[0]));
      const hadVerdict = adopted.refs.includes('verdict');
      adopted.draft = withoutDuplicates(adopted.draft).draft;
      // A remoção desloca a numeração: audita as seções tocadas inteiras (e a resposta curta, se mudou).
      adopted.refs = [...(hadVerdict ? ['verdict'] : []), ...blockRefs(adopted.draft).map((u) => u.ref).filter((r) => r !== 'verdict' && secs.has(r.split('#')[0]))];
      const vStyle = styleIssues(adopted.draft).filter((i) => i.ref === 'verdict');
      if (vStyle.length) {
        const pv = await writePatches(topic, claims, idx.sources, adopted.draft, [{ ref: 'verdict', msg: `${vStyle.map((i) => i.msg).join(' ')} Mantenha o conteúdo e as fontes; mude só a forma.` }], fetchImpl);
        add(pv.usage);
        adopted.draft = applyPatches(adopted.draft, pv.data.patches.filter((x) => x.ref === 'verdict'));
        if (!adopted.refs.includes('verdict')) adopted.refs.push('verdict');
      }
      // A versão do auditor volta sem dizer de quem é a recomendação: atribuição por código de novo (22/10, cadeira
      // para obeso: a resposta curta adotada travou em MISATTRIBUTED; com "segundo a X" o auditor aprova 3 de 3).
      const at = attributeSingleSource(adopted.draft, sourceOf);
      adopted.draft = at.draft;
      for (const r of at.refs) if (!adopted.refs.includes(r)) adopted.refs.push(r);
      adopted.refs = adopted.refs.filter((r) => blockRefs(adopted.draft).some((u) => u.ref === r));
      const st = [...checkPage(toPageSpec(adopted.draft, topic, runId, 'pending'), idx).map((v) => ({ ref: refFromWhere(v.where), msg: `${v.code} ${v.detail}` })), ...styleIssues(adopted.draft)];
      if (!st.some((i) => i.ref === null || adopted.refs.includes(i.ref!))) {
        const a = await auditDraft(adopted.draft, idx.claims, idx.sources, fetchImpl, cache, new Set(adopted.refs));
        add(a.usage, a.usage.calls);
        const still = a.findings.filter((f) => f.verdict !== 'SUPPORTED');
        writeStage(runId, 'adopt-fixes', { adopted: adopted.refs, still: still.map((f) => `${f.ref}: ${f.verdict}`) });
        draft = adopted.draft;
        issues = [...issues.filter((i) => i.ref && !adopted.refs.includes(i.ref)), ...still.map((f) => ({ ref: f.ref, msg: `${f.verdict}. ${f.problem}` }))];
        if (issues.length === 0) return finish(draft, MAX_FIX_ROUNDS + 1);
      }
    }
  }
  // Só sobrou problema de forma que dá para consertar sem IA: conserta, confere a forma e audita os blocos tocados.
  if (draft && issues.length > 0) {
    const ff0 = fixFormWithoutAI(draft);
    const ffa = attributeSingleSource(ff0.draft, sourceOf);
    const ff = { draft: ffa.draft, refs: [...new Set([...ff0.refs, ...ffa.refs])] };
    if (ff.refs.length) {
      const left = [...checkPage(toPageSpec(ff.draft, topic, runId, 'pending'), idx).map((v) => ({ ref: refFromWhere(v.where), msg: `${v.code} ${v.detail}` })), ...styleIssues(ff.draft)];
      // Atribuição recusada em bloco que a atribuição por código acabou de nomear também conta como só de forma.
      const formOnly = issues.every((i) => i.ref && ff.refs.includes(i.ref) && (!/^(OVERSTATED|UNSUPPORTED|MISATTRIBUTED|SAFETY_CLAIM|FACT_IN_FRAMING)/.test(i.msg) || (/^MISATTRIBUTED/.test(i.msg) && ffa.refs.includes(i.ref))));
      if (formOnly && left.length === 0) {
        const a = await auditDraft(ff.draft, idx.claims, idx.sources, fetchImpl, cache, new Set(ff.refs));
        add(a.usage, a.usage.calls);
        writeStage(runId, 'form-fix', { refs: ff.refs, findings: a.findings });
        if (a.findings.every((f) => f.verdict === 'SUPPORTED')) return finish(ff.draft, MAX_FIX_ROUNDS + 1);
        // A versão com a forma certa nunca tinha sido auditada (a forma barrava antes) e pode ter problema de
        // conteúdo: adota a versão sustentada do auditor, conserta a forma de novo e audita uma última vez.
        const ad = adoptAuditorFixes(ff.draft, a.findings);
        if (ad.refs.length) {
          const ff2a = fixFormWithoutAI(ad.draft);
          const ff2b = attributeSingleSource(ff2a.draft, sourceOf);
          const ff2 = { draft: ff2b.draft, refs: [...new Set([...ff2a.refs, ...ff2b.refs])] };
          const refs2 = [...new Set([...ad.refs, ...ff2.refs])];
          const left2 = [...checkPage(toPageSpec(ff2.draft, topic, runId, 'pending'), idx), ...styleIssues(ff2.draft)];
          if (left2.length === 0) {
            const a2 = await auditDraft(ff2.draft, idx.claims, idx.sources, fetchImpl, cache, new Set(refs2));
            add(a2.usage, a2.usage.calls);
            writeStage(runId, 'form-fix-2', { refs: refs2, findings: a2.findings });
            if (a2.findings.every((f) => f.verdict === 'SUPPORTED')) return finish(ff2.draft, MAX_FIX_ROUNDS + 1);
          }
        }
      }
    }
  }
  // Resposta curta recusada no fim: monta uma nova a partir das regras "Se você…" que a checagem antes da redação
  // achou (cada uma com as evidências dela), com atribuição por código, e audita só ela (23/10: nas 3 páginas que
  // pararam na simulação, todos os blocos passaram e só a resposta curta, a síntese, foi recusada).
  if (draft && issues.some((i) => i.ref === 'verdict')) {
    const vr = verdictFromRules(topic.editorial_notes, idx.claims);
    if (vr) {
      const cand0 = { ...draft, verdict: { text: vr.text, basis: 'evidence' as const, claim_ids: vr.claim_ids } };
      const cand = attributeSingleSource(fixFormWithoutAI(cand0 as Draft).draft, sourceOf).draft;
      if (!styleIssues(cand).some((i) => i.ref === 'verdict')) {
        const a = await auditDraft(cand, idx.claims, idx.sources, fetchImpl, cache, new Set(['verdict']));
        add(a.usage, a.usage.calls);
        writeStage(runId, 'verdict-from-rules', { text: cand.verdict.text, findings: a.findings });
        if (a.findings.every((f) => f.verdict === 'SUPPORTED')) {
          draft = cand;
          issues = issues.filter((i) => i.ref !== 'verdict');
          if (issues.length === 0) return finish(draft, MAX_FIX_ROUNDS + 1);
        }
      }
    }
  }
  // Não convergiu, mas sobraram poucos blocos sem prova: remove esses blocos (remover nunca acrescenta
  // fato) e, se o gate passar, segue para a revisão editorial como qualquer página. Antes, 1 bloco ruim
  // descartava a página inteira depois de 4 rodadas pagas do redator (21/10: 37,8 créditos perdidos).
  if (draft && issues.length > 0 && issues.length <= SALVAGE_MAX && issues.every((i) => i.ref && i.ref !== 'verdict')) {
    const salvaged = applyPatches(draft, issues.map((i) => ({ ref: i.ref!, action: 'remove' as const })));
    const gate = [...checkPage(toPageSpec(salvaged, topic, runId, 'pending'), idx), ...styleIssues(salvaged)];
    if (gate.length === 0 && salvaged.sections.length >= 2) {
      writeStage(runId, 'salvage', { removed: issues.map(show) });
      return finish(salvaged, MAX_FIX_ROUNDS + 1);
    }
  }
  // Não salvou: nada vai para data/pages. O rascunho e os problemas ficam no run para análise.
  const open = issues.map(show);
  writeStage(runId, 'page', { slug, status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', open_issues: open, usage, credits: creditsSpent() });
  return { status: 'SAFE_STOP', reason: 'AUDIT_NOT_CONVERGED', rounds: MAX_FIX_ROUNDS + 1, open_issues: open, usage };
}

// Resposta curta a partir das regras gravadas pela checagem antes da redação (nota "Regra de decisão sustentada:
// … (evidências: id, id)"): as 2 primeiras, cada uma uma frase, com as evidências que existem.
export function verdictFromRules(notes: string[], claims: Map<string, unknown>): { text: string; claim_ids: string[] } | null {
  const rules = notes
    .filter((n) => n.startsWith('Regra de decisão sustentada:'))
    .map((n) => {
      const ids = /\(evidências:\s*([^)]*)\)\s*$/.exec(n)?.[1]?.split(/,\s*/).filter((id) => claims.has(id)) ?? [];
      const text = n.replace(/^Regra de decisão sustentada:\s*/, '').replace(/\s*\(evidências:[^)]*\)\s*$/, '').trim().replace(/[.\s]*$/, '.');
      return { text, ids };
    })
    .filter((r) => r.ids.length && r.text.length > 15)
    .slice(0, 2);
  if (!rules.length) return null;
  return { text: rules.map((r) => r.text).join(' '), claim_ids: [...new Set(rules.flatMap((r) => r.ids))] };
}
