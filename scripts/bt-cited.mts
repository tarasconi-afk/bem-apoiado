// Teste da busca dos modelos citados (rodar só na cópia de teste da VPS): npx tsx scripts/bt-cited.mts <slug>...
const { findCitedProducts } = await import(process.cwd() + '/packages/engine/src/stages/products.ts');
for (const slug of process.argv.slice(2)) {
  const r = await findCitedProducts(slug, `bt-cited-${slug}`);
  console.log(`== ${slug}\n citados: ${r.cited.join('; ') || '(nenhum)'}\n adicionados: ${r.added.map((a: { label: string; asin: string }) => `${a.label} ${a.asin}`).join('; ') || '(nenhum)'}\n pulados: ${r.skipped.map((s: { reason: string }) => s.reason).slice(0, 6).join(' | ')}`);
}
