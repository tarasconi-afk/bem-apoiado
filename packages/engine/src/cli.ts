import { parseArgs } from 'node:util';
import { checkClaim, checkPage, checkProduct, SourceClass, type Violation } from '@bem-apoiado/core';
import { z } from 'zod';
import { callJson, creditsSpent, setRunBudget } from './llm.ts';
import { MODELS, type Role } from './models.ts';
import { newRunId } from './runs.ts';
import { rawIntact, reextract, snapshot } from './snapshot.ts';
import { buildPage } from './stages/page.ts';
import { renderStatus } from './status.ts';
import { research } from './stages/research.ts';
import { buildIndex, loadPages, loadProducts, loadSources } from './store.ts';

const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case 'snapshot': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { publisher: { type: 'string' }, class: { type: 'string' }, note: { type: 'string' } },
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
      for (const p of products) violations.push(...checkProduct(p, idx));
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
      console.log(`página gravada: data/pages/${slug}.json (${r.page.sections.length} seções)`);
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
