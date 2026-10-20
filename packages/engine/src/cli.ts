import { parseArgs } from 'node:util';
import { checkClaim, checkPage, checkProduct, SourceClass, TopicBrief, type Violation } from '@bem-apoiado/core';
import { z } from 'zod';
import { callJson, creditsSpent, setRunBudget } from './llm.ts';
import { MODELS, type Role } from './models.ts';
import { newRunId } from './runs.ts';
import { rawIntact, reextract, snapshot } from './snapshot.ts';
import { discoverSources } from './stages/discover.ts';
import { improveTopic } from './stages/improve.ts';
import { planTopic } from './stages/plan.ts';
import { bootstrapNiche } from './stages/bootstrap.ts';
import { runCycle } from './stages/autopilot.ts';
import { findProducts, findProductsFromAmazon } from './stages/products.ts';
import { editPage } from './stages/edit.ts';
import { buildPage } from './stages/page.ts';
import { reviewPage } from './stages/review.ts';
import { loadTopic } from './stages/research.ts';
import { creditsThisMonth, MONTHLY_CREDIT_CAP, webSearch } from './search.ts';
import { renderStatus } from './status.ts';
import { research } from './stages/research.ts';
import { buildIndex, loadPages, loadProducts, loadSources, loadTopics, PAGES_DIR, TOPICS_DIR, writeJson } from './store.ts';
import { loadNiche } from './niche.ts';
import { join } from 'node:path';

const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case 'snapshot': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { publisher: { type: 'string' }, class: { type: 'string' }, note: { type: 'string' }, via: { type: 'string', default: 'direct' } },
      });
      const url = positionals[0];
      if (!url || !values.publisher || !values.class) {
        console.error('uso: snapshot <url> --publisher "Nome" --class manufacturer|regulator|standard_body|independent_test|retailer_listing|other');
        return 2;
      }
      const { source, created } = await snapshot({
        url,
        publisher: values.publisher,
        sourceClass: SourceClass.parse(values.class),
        via: values.via === 'tavily' ? 'tavily' : 'direct',
        ...(values.note ? { note: values.note } : {}),
      });
      console.log(`${created ? 'NOVO' : 'JA_EXISTE'} ${source.id} ${source.text_chars} chars ${source.final_url}`);
      return 0;
    }
    case 'validate': {
      // Gate determinístico: roda antes de todo build. Qualquer violação impede a publicação.
      const idx = buildIndex();
      const violations: Violation[] = [];
      for (const s of idx.sources.values()) {
        if (!rawIntact(s)) violations.push({ code: 'SOURCE_RAW_CORRUPT', where: `source:${s.id}`, detail: s.raw_file });
      }
      for (const claim of idx.claims.values()) violations.push(...checkClaim(claim, idx));
      const products = loadProducts();
      const kindLabels = new Map(loadNiche().product_kinds.map((k) => [k.id, k.label]));
      for (const p of products) violations.push(...checkProduct(p, idx, new Date(), kindLabels.get(p.kind), loadNiche().forbidden_terms));
      // Vocabulário de tipos de produto pertence ao perfil de nicho.
      const kinds = new Set(loadNiche().product_kinds.map((k) => k.id));
      for (const p of products) if (!kinds.has(p.kind)) violations.push({ code: 'PRODUCT_KIND_NOT_IN_NICHE', where: `product:${p.asin}`, detail: p.kind });
      for (const t of loadTopics()) for (const k of t.product_kinds) if (!kinds.has(k)) violations.push({ code: 'TOPIC_KIND_NOT_IN_NICHE', where: `topic:${t.slug}`, detail: k });
      const pages = loadPages();
      for (const page of pages) {
        violations.push(...checkPage(page, idx).map((v) => ({ ...v, where: `${page.slug}:${v.where}` })));
      }
      for (const v of violations) console.error(`✗ ${v.code} ${v.where} ${v.detail}`);
      console.log(
        `validate: ${idx.sources.size} fontes, ${idx.claims.size} evidências, ${products.length} produtos, ${pages.length} páginas, ${violations.length} violações`,
      );
      return violations.length === 0 ? 0 : 1;
    }
    case 'reextract': {
      for (const s of loadSources()) {
        if (!rawIntact(s)) {
          console.error(`✗ ${s.id} bruto corrompido; rode snapshot de novo em ${s.url}`);
          continue;
        }
        const u = await reextract(s);
        console.log(`${u.id} ${s.text_chars} -> ${u.text_chars} chars (v${u.extractor_version})`);
      }
      console.log('Rode `validate` em seguida: trechos citados precisam continuar presentes.');
      return 0;
    }
    case 'research': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { only: { type: 'string', multiple: true }, budget: { type: 'string', default: '40' } },
      });
      setRunBudget(Number(values.budget));
      const slug = positionals[0];
      if (!slug) {
        console.error('uso: research <slug-da-pauta> [--only src_x ...]');
        return 2;
      }
      const runId = newRunId(slug);
      const r = await research(slug, runId, undefined, values.only);
      for (const [q, n] of Object.entries(r.coverage)) console.log(`${n > 0 ? '✓' : '✗'} ${q}: ${n} evidências`);
      const byReason = new Map<string, number>();
      r.rejected.forEach((x) => byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + 1));
      console.log(
        `run ${runId}: ${r.accepted.length} aceitas, ${r.rejected.length} rejeitadas ${JSON.stringify(Object.fromEntries(byReason))}, ` +
          `${r.usage.calls} chamadas, tokens ${r.usage.input_tokens}/${r.usage.output_tokens}, ~${creditsSpent().toFixed(1)} créditos, erros ${r.errors.length}`,
      );
      for (const e of r.errors) console.error(`✗ ${e.source_id}: ${e.error}`);
      return r.errors.length === 0 ? 0 : 1;
    }
    case 'page': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { budget: { type: 'string', default: '80' } } });
      const slug = positionals[0];
      if (!slug) {
        console.error('uso: page <slug-da-pauta> [--budget créditos]');
        return 2;
      }
      setRunBudget(Number(values.budget));
      const runId = newRunId(slug);
      const r = await buildPage(slug, runId);
      console.log(
        `run ${runId}: ${r.status} em ${r.rounds} rodada(s), ${r.usage.calls} chamadas, tokens ${r.usage.input_tokens}/${r.usage.output_tokens}, ~${creditsSpent().toFixed(1)} créditos`,
      );
      if (r.status === 'SAFE_STOP') {
        console.error(`SAFE_STOP ${r.reason}`);
        for (const i of r.open_issues) console.error(`  · ${i}`);
        return 1;
      }
      console.log(`página gravada: data/pages/${slug}.json (${r.page.sections.length} seções, status ${r.page.status})`);
      if (r.status === 'NOT_PUBLISHABLE') {
        console.error(`revisão editorial reprovou: ${r.review.summary}`);
        for (const m of r.review.missing) console.error(`  falta: ${m}`);
        return 1;
      }
      return 0;
    }
    case 'edit': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { budget: { type: 'string', default: '30' } } });
      const page = loadPages().find((p) => p.slug === positionals[0]);
      if (!page) {
        console.error('uso: edit <slug-de-página-existente> [--budget créditos]');
        return 2;
      }
      setRunBudget(Number(values.budget));
      const runId = newRunId(`${page.slug}-edit`);
      const r = await editPage(page, runId);
      console.log(`run ${runId}: ${JSON.stringify(r)} ~${creditsSpent().toFixed(1)} créditos`);
      return r.status === 'REVERTED' ? 1 : 0;
    }
    case 'discover': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { searches: { type: 'string', default: '8' }, sources: { type: 'string', default: '14' }, budget: { type: 'string', default: '5' } },
      });
      if (!positionals[0]) {
        console.error('uso: discover <slug> [--searches 8] [--sources 14]');
        return 2;
      }
      setRunBudget(Number(values.budget));
      const runId = newRunId(`${positionals[0]}-discover`);
      const r = await discoverSources(positionals[0], runId, { maxSearches: Number(values.searches), maxSources: Number(values.sources) });
      for (const a of r.added) console.log(`${a.created ? 'NOVA ' : 'JÁ   '} ${a.source_class.padEnd(16)} ${a.publisher.padEnd(14)} ${a.url}`);
      for (const e of r.snapshot_errors) console.error(`✗ ${e.url}: ${e.error}`);
      console.log(`run ${runId}: ${r.queries.length} buscas, ${r.added.length} fontes, ${r.skipped_blocked} bloqueadas, ${r.suggestions.length} domínios sugeridos; Tavily no mês: ${r.tavily_credits_month}`);
      for (const s of r.suggestions.slice(0, 12)) console.log(`  sugestão: ${s.host}  (${s.title.slice(0, 60)})`);
      return 0;
    }
    case 'search': {
      const q = rest.join(' ').trim();
      if (!q) {
        console.error('uso: search <consulta>');
        return 2;
      }
      const results = await webSearch(q);
      for (const r of results) console.log(`${r.score.toFixed(2)}  ${r.url}\n      ${r.title}`);
      console.log(`Tavily este mês: ${creditsThisMonth()} / ${MONTHLY_CREDIT_CAP} créditos`);
      return 0;
    }
    case 'review': {
      // Reavalia uma página existente: reprovada vira rascunho; aprovada só sobe se a auditoria passou.
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const page = loadPages().find((p) => p.slug === positionals[0]);
      if (!page) {
        console.error('uso: review <slug>');
        return 2;
      }
      setRunBudget(10);
      const topic = loadTopic(page.slug);
      const { review } = await reviewPage(page, topic);
      // Grava o resultado: lacunas na pauta; página reprovada vira rascunho, aprovada só volta a valer
      // se já tinha passado na auditoria de evidências.
      writeJson(join(TOPICS_DIR, `${page.slug}.json`), TopicBrief.parse({ ...topic, evidence_gaps: review.publishable ? [] : review.missing }));
      const status = review.publishable && page.provenance.audit_verdict === 'pass' ? 'approved' : 'draft';
      if (status !== page.status && page.status !== 'published') writeJson(join(PAGES_DIR, `${page.slug}.json`), { ...page, status });
      console.log(JSON.stringify(review, null, 2));
      console.log(`~${creditsSpent().toFixed(1)} créditos`);
      return review.publishable ? 0 : 1;
    }
    case 'improve': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { budget: { type: 'string', default: '90' } } });
      if (!positionals[0]) {
        console.error('uso: improve <slug> [--budget créditos]');
        return 2;
      }
      setRunBudget(Number(values.budget));
      const runId = newRunId(`${positionals[0]}-improve`);
      const r = await improveTopic(positionals[0], runId);
      console.log(`run ${runId}: ${JSON.stringify(r)}`);
      return r.status === 'DONE' && r.page === 'PASS' ? 0 : 1;
    }
    case 'learning': {
      const { computeLearning, plannerHints } = await import('./learning.ts');
      const l = computeLearning();
      for (const d of [...l.domains.values()].sort((a, b) => b.claims - a.claims))
        console.log(`${d.host.padEnd(22)} lidas ${String(d.researched).padStart(2)}  úteis ${String(d.productive).padStart(2)}  evidências ${String(d.claims).padStart(3)}  em aprovadas ${String(d.cited_in_approved).padStart(3)}  rendimento ${Math.round(d.yield * 100)}%`);
      console.log('\n--- dicas para o planejador ---\n' + plannerHints(l));
      return 0;
    }
    case 'plan': {
      const q = rest.join(' ').trim();
      if (!q) {
        console.error('uso: plan "<dúvida principal>"');
        return 2;
      }
      setRunBudget(10);
      const { topic, created } = await planTopic(q);
      console.log(`${created ? 'NOVA' : 'JÁ EXISTE'} pauta ${topic.slug} (${topic.page_type}), produtos: ${topic.product_kinds.join(', ') || '-'}`);
      for (const x of topic.questions) console.log(`  ${x.id}: ${x.text}`);
      console.log(`  termos de foco: ${topic.focus_terms.join(', ')}  ~${creditsSpent().toFixed(1)} créditos`);
      return 0;
    }
    case 'niche-bootstrap': {
      const theme = rest.join(' ').trim();
      if (!theme) {
        console.error('uso: niche-bootstrap "<tema>"');
        return 2;
      }
      setRunBudget(30);
      const { dir, report, profile } = await bootstrapNiche(theme);
      console.log(`proposta em ${dir} (NÃO ativada)`);
      console.log(`marca: ${profile.brand} | escopo: ${profile.scope}`);
      console.log(`segurança: ${profile.safety_rule}`);
      console.log(`reguladores: ${profile.regulator_hints.join(' | ')}`);
      console.log(`tipos: ${profile.product_kinds.map((k) => k.id).join(', ')}`);
      for (const a of report.accepted) console.log(`  ACEITO  ${a.source_class.padEnd(16)} ${a.host}  (${a.reason.slice(0, 80)})`);
      for (const m of report.maker_checks.filter((x) => !x.ok)) console.log(`  fabricante não conferido: ${m.brand} ${m.domain} (${m.why})`);
      console.log(`  ${report.rejected.length} domínios rejeitados; ~${report.llm_credits.toFixed(1)} créditos; Tavily no mês: ${report.tavily_credits_month}`);
      return 0;
    }
    case 'autopilot': {
      const { values } = parseArgs({ args: rest, options: { budget: { type: 'string', default: '120' } } });
      setRunBudget(Number(values.budget));
      const runId = newRunId('autopilot');
      const r = await runCycle(runId);
      console.log(JSON.stringify({ status: r.status, slug: r.slug, credits: Number(r.credits.toFixed(1)), steps: r.steps }));
      // 0 = há algo para virar PR; 3 = nada a fazer (o script não abre PR)
      return r.status === 'PAGE_APPROVED' || r.status === 'PAGE_DRAFT' || r.status === 'STOPPED' ? 0 : 3;
    }
    case 'products': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { max: { type: 'string', default: '4' }, budget: { type: 'string', default: '20' }, from: { type: 'string', default: 'amazon' } } });
      if (!positionals[0]) {
        console.error('uso: products <slug> [--max 4]');
        return 2;
      }
      setRunBudget(Number(values.budget));
      const runId = newRunId(`${positionals[0]}-products`);
      const r = values.from === 'sheets' ? await findProducts(positionals[0], runId, { max: Number(values.max) }) : await findProductsFromAmazon(positionals[0], runId);
      for (const a of r.added) console.log(`+ ${a.asin}  ${a.kind.padEnd(16)} ${a.label}`);
      for (const k of r.skipped) console.log(`  pulado: ${k.reason}  (${k.url.slice(0, 90)})`);
      console.log(`run ${runId}: ${r.candidates} fichas candidatas, ${r.added.length} produtos; ~${creditsSpent().toFixed(1)} créditos`);
      return 0;
    }
    case 'status': {
      const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } } });
      const html = renderStatus();
      if (values.out) {
        const { writeFileSync, renameSync } = await import('node:fs');
        // Grava em arquivo temporário e renomeia: o Caddy nunca serve um HTML pela metade.
        writeFileSync(`${values.out}.tmp`, html);
        renameSync(`${values.out}.tmp`, values.out);
      } else {
        process.stdout.write(html);
      }
      return 0;
    }
    case 'ping': {
      // Uma chamada mínima por papel: confirma credencial, id do modelo e suporte a saída estruturada.
      const Pong = z.object({ ok: z.boolean(), modelo: z.string() });
      let failures = 0;
      for (const role of Object.keys(MODELS) as Role[]) {
        try {
          const r = await callJson({
            role,
            system: 'Responda só com JSON.',
            user: 'Devolva {"ok": true, "modelo": "<seu nome de modelo>"}.',
            schema: Pong,
            schemaName: 'pong',
            maxTokens: 200,
          });
          console.log(`✓ ${role} ${r.modelName} → ${JSON.stringify(r.data)} tokens=${r.usage.input_tokens}/${r.usage.output_tokens}`);
        } catch (e) {
          failures++;
          console.error(`✗ ${role} ${MODELS[role].name}: ${(e as Error).message}`);
        }
      }
      return failures === 0 ? 0 : 1;
    }
    default:
      console.error('comandos: snapshot | reextract | validate | ping');
      return 2;
  }
}

process.exitCode = await main();
