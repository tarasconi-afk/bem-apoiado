import { join } from 'node:path';
import { z } from 'zod';
import { NicheProfile, SourceClass } from '@bem-apoiado/core';
import { callJson, creditsSpent, type FetchLike } from '../llm.ts';
import { loadRegistry } from './discover.ts';
import { creditsThisMonth, webSearch } from '../search.ts';
import { DATA, writeJson } from '../store.ts';

// Proposta de nicho novo: o motor pesquisa o tema e PROPÕE perfil + cadastro de domínios.
// Nada é ativado: a proposta vai para data/proposals/ e só vale depois de aprovação humana.

const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function bootstrapNiche(theme: string, opts: { maxSearches?: number } = {}, fetchImpl?: FetchLike) {
  const maxSearches = opts.maxSearches ?? 6;

  // 1) Rascunho do perfil e das buscas que acham as fontes oficiais do tema.
  const Draft = z.object({
    profile: NicheProfile,
    searches: z.array(z.object({ q: z.string(), looking_for: z.enum(['regulator', 'standard_body', 'manufacturer', 'independent_test']) })).min(3).max(maxSearches),
  });
  const draft = await callJson(
    {
      role: 'writer',
      system:
        `Você prepara um site de afiliados brasileiro que só usa fontes primárias (reguladores, normas, páginas oficiais de fabricantes) ` +
        `para ajudar leigos a decidir compras. Proponha o perfil do nicho e buscas para encontrar as fontes oficiais.\n` +
        `- "safety_rule": a regra de segurança mais importante do tema (o que o site NUNCA pode afirmar), começando por um rótulo e dois-pontos.\n` +
        `- "regulator_hints": reguladores, certificações e normas brasileiras realmente aplicáveis ao tema. Se não tiver certeza de que existe, não invente: descreva o que procurar.\n` +
        `- "decision_outline": 3 a 5 seções típicas de uma página de decisão, terminando em "Como decidir".\n` +
        `- "product_kinds": ids em snake_case.\n` +
        `- "brand": proponha um nome curto em português que não prometa efeito.`,
      user: `Tema do novo nicho: "${theme}". Gere até ${maxSearches} buscas.`,
      schema: Draft,
      schemaName: 'niche_draft',
      maxTokens: 4000,
    },
    fetchImpl,
  );

  // 2) Buscas reais; domínios candidatos com exemplos de página.
  const reg = loadRegistry();
  const found = new Map<string, { host: string; looking_for: string; examples: { url: string; title: string }[] }>();
  for (const s of draft.data.searches.slice(0, maxSearches)) {
    for (const r of await webSearch(s.q, { maxResults: 8 })) {
      let host: string;
      try {
        host = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (reg.block.some((b) => host === b || host.endsWith(`.${b}`))) continue;
      const e = found.get(host) ?? { host, looking_for: s.looking_for, examples: [] };
      if (e.examples.length < 3) e.examples.push({ url: r.url, title: r.title });
      found.set(host, e);
    }
  }

  // 3) Classificação dos domínios encontrados. Na dúvida, "reject": melhor faltar fonte que entrar fonte ruim.
  const hosts = [...found.values()];
  const Classified = z.object({
    domains: z.array(
      z.object({
        host: z.enum(hosts.map((h) => h.host) as [string, ...string[]]),
        decision: z.enum(['accept', 'reject']),
        publisher: z.string(),
        source_class: SourceClass,
        reason: z.string(),
      }),
    ),
  });
  const cls = hosts.length
    ? await callJson(
        {
          role: 'auditor',
          system:
            `Classifique domínios como fonte para um site que só aceita fontes primárias. "accept" só para: órgão público regulador ` +
            `(gov.br com o órgão no caminho), organismo de normas, site OFICIAL de fabricante, entidade de teste independente. ` +
            `"reject" para lojas, marketplaces, comparadores, blogs, mídia, prefeituras e qualquer caso duvidoso.`,
          user: hosts.map((h) => `${h.host} (buscando: ${h.looking_for})\n  ${h.examples.map((e) => `${e.title} — ${e.url}`).join('\n  ')}`).join('\n\n'),
          schema: Classified,
          schemaName: 'domain_classification',
          maxTokens: 4000,
        },
        fetchImpl,
      )
    : { data: { domains: [] } };

  // Portal compartilhado (gov.br) nunca entra inteiro: só o caminho do órgão visto nos exemplos.
  const SHARED = new Set(['gov.br']);
  const accepted: { host: string; path?: string; publisher: string; source_class: z.infer<typeof SourceClass>; reason: string }[] = [];
  for (const d of cls.data.domains.filter((x) => x.decision === 'accept')) {
    if (!SHARED.has(d.host)) {
      accepted.push(d);
      continue;
    }
    const paths = new Set(found.get(d.host)!.examples.map((e) => '/' + (new URL(e.url).pathname.split('/')[1] ?? '')).filter((p) => p.length > 1));
    for (const path of paths) accepted.push({ ...d, path, reason: `${d.reason} (restrito a ${path})` });
  }

  // 4) Fabricantes: busca genérica não traz site oficial. O modelo lista marcas e domínios prováveis
  //    e o motor CONFERE cada um acessando a página (sem gastar busca).
  const Makers = z.object({ makers: z.array(z.object({ brand: z.string(), domain: z.string() })).max(15) });
  const makers = await callJson(
    {
      role: 'writer',
      system: 'Liste fabricantes/marcas relevantes no Brasil para o tema e o domínio do site oficial brasileiro de cada um (sem https, sem caminho). Se não souber o domínio, omita a marca.',
      user: `Tema: "${theme}". Até 15 marcas.`,
      schema: Makers,
      schemaName: 'makers',
      maxTokens: 1500,
    },
    fetchImpl,
  );
  const makerChecks: { brand: string; domain: string; ok: boolean; why: string }[] = [];
  for (const m of makers.data.makers) {
    const domain = m.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    try {
      const res = await fetch(`https://${domain}/`, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; BemApoiadoBot/0.1)' } });
      const html = (await res.text()).slice(0, 200_000);
      const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? '';
      const brandWord = m.brand.split(/\s+/)[0]!.toLowerCase();
      const finalHost = new URL(res.url).hostname.replace(/^www\./, '');
      const ok = res.ok && (title.toLowerCase().includes(brandWord) || finalHost.includes(brandWord)) && !reg.block.some((b) => finalHost.endsWith(b));
      makerChecks.push({ brand: m.brand, domain: finalHost, ok, why: ok ? `título: ${title.trim().slice(0, 60)}` : `HTTP ${res.status}, título sem a marca: ${title.trim().slice(0, 50)}` });
      if (ok && !accepted.some((a) => a.host === finalHost)) accepted.push({ host: finalHost, publisher: m.brand, source_class: 'manufacturer', reason: `site oficial conferido (${title.trim().slice(0, 50)})` });
    } catch (e) {
      makerChecks.push({ brand: m.brand, domain, ok: false, why: (e as Error).message.slice(0, 60) });
    }
  }
  const dir = join(DATA, 'proposals', `niche-${slugify(theme)}`);
  writeJson(join(dir, 'niche.json'), draft.data.profile);
  writeJson(join(dir, 'domains.json'), {
    _comment: `Proposta gerada pelo motor para "${theme}". Revisar antes de ativar.`,
    allow: accepted.map((d) => ({ host: d.host, ...(d.path ? { path: d.path } : {}), publisher: d.publisher, source_class: d.source_class })),
    block: reg.block,
  });
  const report = {
    theme,
    searches: draft.data.searches,
    accepted: accepted.map((d) => ({ host: d.host + (d.path ?? ''), publisher: d.publisher, source_class: d.source_class, reason: d.reason })),
    maker_checks: makerChecks,
    rejected: cls.data.domains.filter((d) => d.decision === 'reject').map((d) => ({ host: d.host, reason: d.reason })),
    llm_credits: creditsSpent(),
    tavily_credits_month: creditsThisMonth(),
  };
  writeJson(join(dir, 'report.json'), report);
  return { dir, report, profile: draft.data.profile };
}
