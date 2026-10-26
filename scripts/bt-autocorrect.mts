// Teste da correção automática num rascunho (rodar só na cópia de teste da VPS, com BEM_STATE_DIR próprio): npx tsx scripts/bt-autocorrect.mts <slug> <runId>
const { autoCorrect } = await import(process.cwd() + '/packages/engine/src/stages/autopilot.ts');
const steps: string[] = [];
await autoCorrect(process.argv[2]!, process.argv[3]!, steps);
console.log(steps.join('\n') || '(nada)');
