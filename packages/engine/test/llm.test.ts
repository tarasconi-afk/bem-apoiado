import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.BEM_RETRY_MS = '0';
process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-llm-state-'));
import { z } from 'zod';
import { callJson, creditsSpent, LlmError, setRunBudget, type FetchLike } from '../src/llm.ts';
import { ledger } from '../src/credits.ts';

const Out = z.object({ answer: z.string(), n: z.number().int() });

const reply = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    status: 200,
  });

const call = { role: 'extractor' as const, system: 's', user: 'u', schema: Out, schemaName: 'out' };

describe('callJson', () => {
  beforeEach(() => {
    process.env.NEXOS_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.NEXOS_API_KEY;
  });

  it('valida a saída e soma o uso', async () => {
    const f: FetchLike = async () => reply('```json\n{"answer":"ok","n":2}\n```');
    const r = await callJson(call, f);
    expect(r.data).toEqual({ answer: 'ok', n: 2 });
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('reenvia com o erro de validação e aceita a correção', async () => {
    const bodies: string[] = [];
    let i = 0;
    const f: FetchLike = async (_u, init) => {
      bodies.push(String(init.body));
      return reply(i++ === 0 ? '{"answer":"ok","n":"dois"}' : '{"answer":"ok","n":2}');
    };
    const r = await callJson(call, f);
    expect(r.attempts).toBe(2);
    expect(bodies[1]).toContain('não passou na validação');
  });

  it('para depois de duas saídas inválidas', async () => {
    const f: FetchLike = async () => reply('nada');
    await expect(callJson(call, f)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('sem chave falha cedo, sem chamar a rede', async () => {
    delete process.env.NEXOS_API_KEY;
    let called = false;
    const f: FetchLike = async () => {
      called = true;
      return reply('{}');
    };
    await expect(callJson(call, f)).rejects.toBeInstanceOf(LlmError);
    expect(called).toBe(false);
  });
});

describe('callJson: streaming e erros transitórios', () => {
  beforeEach(() => {
    process.env.NEXOS_API_KEY = 'test-key';
  });

  it('monta o conteúdo a partir de eventos SSE e lê o uso do último evento', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"{\\"answer\\":"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"\\"ok\\",\\"n\\":3}"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":7}}',
      'data: [DONE]',
      '',
    ].join('\n');
    const f: FetchLike = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const r = await callJson(call, f);
    expect(r.data).toEqual({ answer: 'ok', n: 3 });
    expect(r.usage).toEqual({ input_tokens: 40, output_tokens: 7 });
  });

  it('usa o valor cobrado pelo roteador (credits_charged) e registra no livro-caixa', async () => {
    setRunBudget(100);
    const sse = 'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"ok\\",\\"n\\":2}"}}]}\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"credits_charged":0.0036}}\n';
    const f: FetchLike = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await callJson(call, f);
    expect(creditsSpent()).toBeCloseTo(0.0036, 6);
    const last = ledger().at(-1)!;
    expect(last).toMatchObject({ what: 'extractor', model: 'claude-haiku-4.5', credits: 0.0036, estimated: false });
  });

  it('524 persistente no redator: troca para o modelo reserva', async () => {
    const models: string[] = [];
    const f: FetchLike = async (_u, init) => {
      const m = JSON.parse(String(init.body)).model as string;
      models.push(m);
      return m === 'claude-haiku-4.5' ? new Response('timeout', { status: 524 }) : reply('{"answer":"ok","n":5}');
    };
    const r = await callJson({ ...call, role: 'writer' as const }, f);
    expect(r.data.n).toBe(5);
    expect(models).toEqual(['claude-haiku-4.5', 'claude-haiku-4.5', 'claude-haiku-4.5', 'claude-sonnet-4.6']);
    expect(r.model).toBe('claude-sonnet-4.6');
  });

  it('tenta de novo uma vez em 524 e segue', async () => {
    let i = 0;
    const f: FetchLike = async () => (i++ === 0 ? new Response('<html>timeout</html>', { status: 524 }) : reply('{"answer":"ok","n":1}'));
    const r = await callJson(call, f);
    expect(r.data.n).toBe(1);
    expect(i).toBe(2);
  }, 15_000);

  it('não repete erro de crédito', async () => {
    let i = 0;
    const f: FetchLike = async () => {
      i++;
      return new Response('{"error":{"message":"Insufficient credits."}}', { status: 402 });
    };
    await expect(callJson(call, f)).rejects.toMatchObject({ code: 'HTTP' });
    expect(i).toBe(1);
  });
});

describe('teto de gasto', () => {
  it('para antes da chamada quando o teto é atingido', async () => {
    process.env.NEXOS_API_KEY = 'test-key';
    const { setRunBudget, creditsSpent } = await import('../src/llm.ts');
    setRunBudget(0.001);
    // 1M de tokens de entrada no extrator = 120 créditos: estoura o teto na primeira chamada.
    const f: FetchLike = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok","n":1}' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
    await callJson(call, f);
    expect(creditsSpent()).toBeCloseTo(120);
    await expect(callJson(call, f)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    setRunBudget(Number.POSITIVE_INFINITY);
  });
});
