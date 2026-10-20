import { parseArgs } from 'node:util';
import { checkClaim, checkPage, SourceClass, type Violation } from '@bem-apoiado/core';
import { snapshot } from './snapshot.ts';
import { buildIndex, loadPages } from './store.ts';

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
      for (const claim of idx.claims.values()) violations.push(...checkClaim(claim, idx));
      const pages = loadPages();
      for (const page of pages) {
        violations.push(...checkPage(page, idx).map((v) => ({ ...v, where: `${page.slug}:${v.where}` })));
      }
      for (const v of violations) console.error(`✗ ${v.code} ${v.where} ${v.detail}`);
      console.log(
        `validate: ${idx.sources.size} fontes, ${idx.claims.size} evidências, ${pages.length} páginas, ${violations.length} violações`,
      );
      return violations.length === 0 ? 0 : 1;
    }
    default:
      console.error('comandos: snapshot | validate');
      return 2;
  }
}

process.exitCode = await main();
