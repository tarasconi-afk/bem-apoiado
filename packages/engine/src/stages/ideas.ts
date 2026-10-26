import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { firstForbidden } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { DATA, loadTopics } from '../store.ts';

// Pautas descobertas sozinhas: o autocompletar do Google mostra o que as pessoas digitam de verdade.
// Para cada tipo de produto do nicho, padrões de decisão ("X ou", "como escolher X"...); o modelo barato
// separa o que é do tema e respondível com fonte primária, e reescreve "qual o melhor X" como
// "como escolher X" (o site não faz ranking). Tudo fica em data/ideas.json; as melhores vão para a fila.

// 26/10: com só as 6 primeiras, o autocompletar rendeu 12 ideias no total e a fila de pautas secou perto da meta de
// 50 páginas. As de situação ("é muito duro", "para quem", "quanto tempo dura") são as que o Search Console mostrou
// sem página que responda.
const PATTERNS = ['{x} ou ', '{x} qual ', 'como escolher {x}', '{x} vale a pena', '{x} diferença', 'qual {x} ', '{x} para ', '{x} é ', 'melhor {x} para ', '{x} quanto ', 'tipos de {x}', 'quando trocar {x}', '{x} ideal', '{x} tamanho', '{x} muito '];
export const IDEAS_FILE = join(DATA, 'ideas.json');

export interface Suggestion { text: string; seed: string; rank: number }

export async function autocomplete(q: string, f: typeof fetch = fetch): Promise<string[]> {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&hl=pt-BR&gl=br&q=${encodeURIComponent(q)}`;
  const r = await f(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return [];
  const body = (await r.json()) as [string, string[]];
  return Array.isArray(body?.[1]) ? body[1] : [];
}

export async function collectSuggestions(seeds: string[], f: typeof fetch = fetch): Promise<Suggestion[]> {
  const out = new Map<string, Suggestion>();
  for (const seed of seeds) {
    for (const p of PATTERNS) {
      const list = await autocomplete(p.replace('{x}', seed), f).catch(() => []);
      list.forEach((text, rank) => {
        const t = text.trim().toLowerCase();
        if (t.split(/\s+/).length < 3) return;
        const prev = out.get(t);
        if (!prev || prev.rank > rank) out.set(t, { text: t, seed, rank });
      });
    }
  }
  return [...out.values()];
}

const slug = (q: string) => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export const Idea = z.object({
  query: z.string(),
  from: z.array(z.string()),
  score: z.number(),
  status: z.enum(['nova', 'na_fila', 'descartada']),
  reason: z.string().default(''),
  found_at: z.string(),
});
export type Idea = z.infer<typeof Idea>;

const Triage = z.object({
  items: z.array(z.object({
    n: z.number().int(),
    keep: z.boolean(),
    query: z.string(), // pauta reescrita como dúvida de decisão ("como escolher X", "X ou Y")
    same_as: z.string().nullable(), // slug de pauta existente com a mesma intenção (variação, não página nova)
    reason: z.string(),
  })),
});

const triageSystem = () => {
  const n = loadNiche();
  return `Você escolhe pautas para o site ${n.brand} (${n.scope}; público: ${n.audience}). O site só publica guias de DECISÃO sustentados por fontes primárias (normas, órgãos reguladores, fichas de fabricantes): explica tipos, diferenças e o que conferir. Não faz ranking, não testa produto, não fala de preço.
Para cada busca numerada, decida keep=true só se: é do tema do site; é uma dúvida de decisão ou de escolha de compra; dá para responder com normas, reguladores ou fichas de fabricante. keep=false para: marca/modelo isolado ("X é bom"), preço/promoção/loja, saúde (${n.safety_rule.split(':')[0]}), outro tema (cozinha, sala, jantar, infantil...), erro de digitação.
Em "query", reescreva a pauta como o leitor buscaria uma decisão: "qual o melhor X" vira "como escolher X"; mantenha comparações "X ou Y". Buscas com a mesma intenção devem receber a MESMA query.
Canibalização: duas páginas para a mesma dúvida competem entre si no Google. Se a busca tem a mesma intenção de uma pauta que JÁ EXISTE (lista abaixo; ex.: "molas ensacadas ou espuma" = "colchão de molas ou espuma"; "diferença entre espuma e mola" = a mesma), responda keep=false e same_as=<slug existente>. Só keep=true para uma dúvida que nenhuma pauta existente responde.
Família de comparações do mesmo atributo (densidades D20/D23/D28/D33/D45, tamanhos solteiro/casal/queen/king): vira UMA pauta-guia ("guia de densidades de colchão", "tamanhos de colchão"), não uma página por par; o par que já existe como pauta continua sendo dela.
Público é adulto: bebê, berço, criança e infantil são outro nicho (keep=false).`;
};

export async function discoverIdeas(fetchImpl: typeof fetch = fetch, llmFetch?: FetchLike, now = new Date()): Promise<{ added: Idea[]; total: number }> {
  const niche = loadNiche();
  // Tipos do nicho e o nome-base de cada um ("colchão de espuma" → "colchão"): sem o nome-base, a busca
  // fica presa nos subtipos de um produto só.
  const labels = niche.product_kinds.filter((k) => k.id !== 'outro').map((k) => k.label.toLowerCase());
  // Nome-base só quando é o substantivo comum a vários tipos ("colchão"); "base", "protetor" e "mesa" sozinhos
  // trouxeram "protetor para porta de madeira" e "mesa ideal para apartamento" (26/10).
  const bases = labels.map((l) => l.split(' de ')[0]!).filter((b, _, all) => all.filter((x) => x === b).length > 1);
  const seeds = [...new Set([...bases, ...labels])];
  const sugg = (await collectSuggestions(seeds, fetchImpl)).filter((s) => !firstForbidden(s.text, niche.forbidden_terms));
  const known = existsSync(IDEAS_FILE) ? z.array(Idea).parse(JSON.parse(readFileSync(IDEAS_FILE, 'utf8'))) : [];
  const seen = new Set(known.flatMap((i) => [slug(i.query), ...i.from.map(slug)]));
  for (const t of loadTopics()) seen.add(t.slug);
  // Triagem em lotes de 80 (até 240): com mais formatos de busca, o corte em 80 jogava fora a maior parte.
  const fresh = sugg.sort((a, b) => a.rank - b.rank).filter((s) => !seen.has(slug(s.text))).slice(0, 240);
  if (!fresh.length) return { added: [], total: known.length };
  const qf = join(DATA, 'queue.json');
  const queued = existsSync(qf) ? (JSON.parse(readFileSync(qf, 'utf8')).items as { query: string }[]).map((i) => `${slug(i.query)}: ${i.query}`) : [];
  const existing = [...loadTopics().map((t) => `${t.slug}: ${t.primary_query}`), ...queued, ...known.filter((i) => i.status !== 'descartada').map((i) => `${slug(i.query)}: ${i.query}`)];
  const r = { data: { items: [] as z.infer<typeof Triage>['items'] } };
  for (let off = 0; off < fresh.length; off += 80) {
    const part = fresh.slice(off, off + 80);
    const rr = await callJson(
      {
        role: 'extractor', system: triageSystem(),
        user: `Pautas que já existem (slug: dúvida):\n${existing.map((e) => `- ${e}`).join('\n') || '- (nenhuma)'}\n\nBuscas para avaliar:\n${part.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`,
        schema: Triage, schemaName: 'ideas_triage', maxTokens: 8000,
      },
      llmFetch,
    );
    // Numeração de cada lote começa em 1: volta para a posição em `fresh`.
    r.data.items.push(...rr.data.items.map((it) => ({ ...it, n: it.n + off })));
  }
  // Variação de pauta existente: guardada como busca daquela pauta (útil para título/seções), não vira página.
  const variants = new Map<string, string[]>();
  for (const it of r.data.items) if (!it.keep && it.same_as && fresh[it.n - 1]) variants.set(it.same_as, [...(variants.get(it.same_as) ?? []), fresh[it.n - 1]!.text]);
  if (variants.size) {
    const vf = join(DATA, 'topic-variants.json');
    const cur: Record<string, string[]> = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : {};
    for (const [k, v] of variants) cur[k] = [...new Set([...(cur[k] ?? []), ...v])];
    writeFileSync(vf, JSON.stringify(cur, null, 2) + '\n');
  }
  const byQuery = new Map<string, Idea>();
  for (const it of r.data.items) {
    const s = fresh[it.n - 1];
    if (!s) continue;
    const q = it.query.trim().toLowerCase();
    if (!it.keep || firstForbidden(q, niche.forbidden_terms) || seen.has(slug(q))) continue;
    const prev = byQuery.get(slug(q));
    // Mais buscas com a mesma intenção e posição mais alta no autocompletar = mais procura.
    const add = 10 - s.rank;
    if (prev) {
      prev.from.push(s.text);
      prev.score += add;
    } else byQuery.set(slug(q), { query: q, from: [s.text], score: add, status: 'nova', reason: it.reason, found_at: now.toISOString() });
  }
  const added = [...byQuery.values()].sort((a, b) => b.score - a.score);
  writeFileSync(IDEAS_FILE, JSON.stringify([...known, ...added], null, 2) + '\n');
  return { added, total: known.length + added.length };
}

// As melhores ideias novas viram pauta (até `max`), marcadas como "na_fila".
export function promoteIdeas(addToQueue: (q: string) => boolean, max: number): string[] {
  if (!existsSync(IDEAS_FILE)) return [];
  const ideas = z.array(Idea).parse(JSON.parse(readFileSync(IDEAS_FILE, 'utf8')));
  const done: string[] = [];
  for (const i of [...ideas].filter((x) => x.status === 'nova').sort((a, b) => b.score - a.score)) {
    if (done.length >= max) break;
    if (addToQueue(i.query)) {
      i.status = 'na_fila';
      done.push(i.query);
    }
  }
  writeFileSync(IDEAS_FILE, JSON.stringify(ideas, null, 2) + '\n');
  return done;
}
