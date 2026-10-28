import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-preflight-'));
process.env.NEXOS_API_KEY = 'sk-de-teste-1234567890';
process.env.TAVILY_API_KEY = 'tvly-de-teste-1234567890';

const { checarBusca, checarIa, impedeTrabalhar, provedorNoTexto } = await import('../src/preflight.ts');
const responde = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;

// 28/10: o roteador recusou às 16h21, o ciclo rodou 7 minutos, gastou 34,6 créditos e terminou como "nada a
// publicar" — o estado normal de quem não tinha pauta. Ninguém foi avisado; o problema só apareceu horas depois.
describe('conferência antes de gastar', () => {
  it('402 é conta sem crédito, e o aviso diz onde comprar (não "confira a chave")', async () => {
    const c = await checarIa(responde(402, '{"error":{"message":"Insufficient credits.","type":"insufficient_quota"}}'));
    expect(c.veredito).toBe('sem_credito');
    expect(c.resolver).toMatch(/compre crédito/i);
    // A armadilha que custou as horas: o painel mostrava 40 mil créditos enquanto o Router recusava tudo.
    expect(c.resolver).toMatch(/não é o que o AI Router gasta/i);
  });

  it('chave recusada é outro problema, com outra saída', async () => {
    expect((await checarIa(responde(401, 'bad key'))).veredito).toBe('credencial');
    expect((await checarIa(responde(403, 'forbidden'))).veredito).toBe('credencial');
  });

  // Visto na VPS em 28/10, com crédito e tudo funcionando: o modelo gasta tokens de raciocínio e o roteador
  // devolve 400 por estourar a saída. Tratar isso como falha mandaria um email por ciclo com o motor sadio —
  // e alarme falso ensina a ignorar o email de verdade.
  it('saída truncada é sucesso: a conta deixou trabalhar', async () => {
    const c = await checarIa(responde(400, '{"error":{"message":"Could not finish the message because max_tokens or model output limit was reached."}}'));
    expect(c.veredito).toBe('ok');
  });

  it('outro 400 continua sendo problema', async () => {
    expect((await checarIa(responde(400, '{"error":{"message":"model not found"}}'))).veredito).toBe('fora_do_ar');
  });

  it('5xx e rede caída não viram "sem crédito": são passageiros', async () => {
    expect((await checarIa(responde(500, 'oops'))).veredito).toBe('fora_do_ar');
    const cai = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    expect((await checarIa(cai)).veredito).toBe('fora_do_ar');
  });

  it('respondeu: libera o ciclo', async () => {
    const c = await checarIa(responde(200, JSON.stringify({ usage: { credits_charged: 0.0003 } })));
    expect(c.veredito).toBe('ok');
    expect(impedeTrabalhar([c, checarBusca()])).toBeNull();
  });

  // Sem IA nada feito; sem busca o motor ainda melhora página no ar com o que já tem em casa.
  it('só a IA impede trabalhar', () => {
    const semBusca = { servico: 'busca', veredito: 'teto', detalhe: '', resolver: '' } as const;
    const semIa = { servico: 'ia', veredito: 'sem_credito', detalhe: '', resolver: '' } as const;
    expect(impedeTrabalhar([semBusca])).toBeNull();
    expect(impedeTrabalhar([semBusca, semIa])?.servico).toBe('ia');
  });

  it('busca com chave e folga passa', () => {
    expect(checarBusca().veredito).toBe('ok');
  });
});

// O buraco que deixou o silêncio durar: "nada a publicar" tinha dois significados e o alerta tratava os dois
// como normais. Este é o texto REAL do ciclo das 16h de 28/10.
describe('ciclo que não publicou: falta de pauta ou provedor recusando?', () => {
  const CICLO_28_10 = `{"status":"NOTHING_TO_DO","credits":34.6,"steps":["imagens: pagina-travesseiro (~10.1 créditos)","home reordenada pelo Search Console","ideias: falhou (HTTP 402 {\\"error\\":{\\"message\\":\\"Insufficient credits.\\",\\"type\\":\\"insufficient_quota\\")","links internos: falhou (HTTP 402 ...)","planejamento de \\"edredom ou cobertor: diferença\\" falhou (HTTP 402 ...)"]}`;

  it('reconhece o 402 no meio do ciclo e manda comprar crédito', () => {
    const c = provedorNoTexto(CICLO_28_10);
    expect(c?.servico).toBe('ia');
    expect(c?.veredito).toBe('sem_credito');
    expect(c?.resolver).toMatch(/compre crédito/i);
  });

  it('ciclo tranquilo sem pauta pronta continua sem aviso', () => {
    expect(provedorNoTexto('{"status":"NOTHING_TO_DO","credits":0.4,"steps":["nenhuma pauta pronta para escrever","fila vazia"]}')).toBeNull();
  });

  it('cota de busca esgotada também avisa, mas como busca', () => {
    const c = provedorNoTexto('discover: cota do plano Tavily esgotada: HTTP 432');
    expect(c?.servico).toBe('busca');
    expect(c?.veredito).toBe('teto');
  });

  it('falta de chave aparece como credencial', () => {
    expect(provedorNoTexto('erro: NEXOS_API_KEY ausente (ambiente ou /etc/bem-apoiado/env)')?.veredito).toBe('credencial');
  });
});
