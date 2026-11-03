import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 01/11, 10:14: as 3 leituras da coerência falharam juntas e o motor lançou um Error COMUM. O buildPage só
// converte LlmError em parada segura, então o Error escapou, derrubou o ciclo, e o ciclo seguinte fez reset
// --hard: tudo o que o ciclo derrubado tinha pago foi jogado fora. Falha do provedor tem de chegar como
// LlmError, com o código original quando houver (ex.: BUDGET_EXCEEDED), para cair no caminho de parada segura.
process.env.NEXOS_API_KEY = 'teste-sem-rede';
const quebrado = (async () => { throw new Error('rede fora do ar'); }) as never;

describe('juiz cujas 3 chamadas falham', () => {
  it('a coerência devolve LlmError, não Error comum', async () => {
    const { auditCoherence } = await import('../src/stages/coherence.ts');
    const { LlmError } = await import('../src/llm.ts');
    const page = JSON.parse(readFileSync(join(process.cwd(), 'data', 'pages', 'travesseiro-alto-ou-baixo.json'), 'utf8'));
    const erro = await auditCoherence(page, 'travesseiro alto ou baixo', new Map(), new Map(), quebrado).then(() => null, (e: unknown) => e);
    expect(erro, 'deveria ter falhado').not.toBeNull();
    expect(erro).toBeInstanceOf(LlmError);
  });

  it('a revisão devolve LlmError, não Error comum', async () => {
    const { reviewPage } = await import('../src/stages/review.ts');
    const { LlmError } = await import('../src/llm.ts');
    const page = JSON.parse(readFileSync(join(process.cwd(), 'data', 'pages', 'travesseiro-alto-ou-baixo.json'), 'utf8'));
    const topic = JSON.parse(readFileSync(join(process.cwd(), 'data', 'topics', 'travesseiro-alto-ou-baixo.json'), 'utf8'));
    const erro = await reviewPage(page, topic, quebrado).then(() => null, (e: unknown) => e);
    expect(erro, 'deveria ter falhado').not.toBeNull();
    expect(erro).toBeInstanceOf(LlmError);
  });
});
