// Teste da descoberta de pautas (rodar só na cópia de teste da VPS): npx tsx scripts/bt-ideas.mts
const { discoverIdeas } = await import(process.cwd() + '/packages/engine/src/stages/ideas.ts');
const r = await discoverIdeas();
console.log(`novas: ${r.added.length} (total ${r.total})`);
for (const i of r.added) console.log(`${String(i.score).padStart(3)}  ${i.query}   ← ${i.from.slice(0, 2).join(' | ')}`);
