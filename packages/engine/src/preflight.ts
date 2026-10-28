import { ENV_FILE_PATH } from './env.ts';
import { recordCharge } from './credits.ts';
import { keysOf, secret } from './secrets.ts';
import { braveUsageByKey, BRAVE_MONTHLY_CAP, MONTHLY_CREDIT_CAP, usageByKey } from './search.ts';
import { writeState } from './store.ts';

// Conferência antes de gastar: o provedor aceita trabalhar agora?
//
// 28/10: o roteador parou de aceitar chamadas às 16h21 e o ciclo das 16h rodou SETE MINUTOS, gastou 34,6 créditos
// e só então bateu no muro — três etapas falharam com HTTP 402 e o ciclo terminou como "nada a publicar", que é
// o estado normal de quem não tinha pauta pronta. Ninguém foi avisado: o alerta ignora o código 3 de propósito.
// Só se descobriu horas depois, por acaso.
//
// A causa não era nossa (o painel da Hostinger mostrava 40 mil créditos que o Router não enxergava), e por isso
// mesmo o motor tem de saber dizer "não sou eu". Duas perguntas baratas, antes de qualquer trabalho:
//   IA    — uma chamada mínima de verdade. É o único teste que vale: a chave autentica e lista os 161 modelos
//           mesmo sem crédito, então /v1/models responder 200 não prova nada (28/10, provado nas três chaves).
//   busca — contadores locais, sem rede e sem custo.

export type Veredito = 'ok' | 'sem_credito' | 'credencial' | 'fora_do_ar' | 'sem_chave' | 'teto';

export interface Checagem {
  servico: 'ia' | 'busca';
  veredito: Veredito;
  detalhe: string;
  resolver: string; // o que o dono faz; o alerta sem isto custou horas em 28/10
}

const OK_IA: Checagem = { servico: 'ia', veredito: 'ok', detalhe: 'o roteador respondeu e cobrou', resolver: '' };

// Modelo mais barato do catálogo, uma palavra de entrada e um token de saída: ~0,0003 crédito por checagem.
// Quatro ciclos e três vigias por dia dão menos de um crédito por mês — mais barato que uma frase gerada.
const MODELO = process.env.BEM_PREFLIGHT_MODEL ?? 'gpt-5-nano';

export async function checarIa(fetchImpl: typeof fetch = fetch): Promise<Checagem> {
  const key = secret('llm');
  if (!key) {
    return { servico: 'ia', veredito: 'sem_chave', detalhe: `nenhuma chave de IA (ambiente ou ${ENV_FILE_PATH})`, resolver: 'cadastre a chave em Configurações → Chaves do projeto, ou no arquivo de ambiente da VPS' };
  }
  const base = (process.env.NEXOS_BASE_URL ?? 'https://router.hostinger.com/v1').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELO, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { servico: 'ia', veredito: 'fora_do_ar', detalhe: `não deu para falar com o roteador: ${(e as Error).message}`, resolver: 'em geral passa sozinho; se durar, confira se a VPS está com rede' };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { usage?: { credits_charged?: number } };
    recordCharge('preflight', MODELO, body.usage?.credits_charged ?? 0, false);
    return OK_IA;
  }
  const texto = (await res.text().catch(() => '')).slice(0, 200);
  // 402 com a chave válida é o caso de 28/10: conta sem crédito GASTÁVEL, que não é o saldo que o painel mostra.
  if (res.status === 402 || /insufficient[_ ]?(credits|quota)/i.test(texto)) {
    return {
      servico: 'ia',
      veredito: 'sem_credito',
      detalhe: `o roteador recusou: HTTP ${res.status} ${texto}`,
      resolver: 'compre crédito na Hostinger, em Faturamento. ATENÇÃO: o saldo mostrado na tela de IA não é o que o AI Router gasta — em 28/10 ele exibia 40.153 créditos com o Router recusando tudo. Só crédito comprado destravou.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { servico: 'ia', veredito: 'credencial', detalhe: `o roteador não aceitou a chave: HTTP ${res.status} ${texto}`, resolver: 'gere outra chave no hPanel e cadastre em Configurações → Chaves do projeto' };
  }
  return { servico: 'ia', veredito: 'fora_do_ar', detalhe: `HTTP ${res.status} ${texto}`, resolver: 'em geral passa sozinho; se durar, abra chamado na Hostinger' };
}

// Busca: só contador local, sem rede e sem custo. "Teto" aqui é decisão nossa (não pagar além do plano grátis),
// então o aviso diz quando volta, em vez de pedir providência impossível.
export function checarBusca(): Checagem {
  const tavily = keysOf('tavily');
  const brave = keysOf('brave');
  if (!tavily.length && !brave.length) {
    return { servico: 'busca', veredito: 'sem_chave', detalhe: 'nenhuma chave de busca cadastrada', resolver: 'cadastre a chave da Tavily em Configurações → Chaves do projeto' };
  }
  const usoT = usageByKey();
  const livreT = tavily.filter((k) => (usoT[k.id] ?? 0) + 1 <= MONTHLY_CREDIT_CAP);
  if (livreT.length) {
    const sobra = livreT.reduce((t, k) => t + (MONTHLY_CREDIT_CAP - (usoT[k.id] ?? 0)), 0);
    return { servico: 'busca', veredito: 'ok', detalhe: `${livreT.length} de ${tavily.length} conta(s) Tavily com folga (~${Math.round(sobra)} buscas no mês)`, resolver: '' };
  }
  const usoB = braveUsageByKey();
  const livreB = brave.filter((k) => (usoB[k.id] ?? 0) + 1 <= BRAVE_MONTHLY_CAP);
  if (livreB.length) {
    return { servico: 'busca', veredito: 'ok', detalhe: `Tavily no teto; a reserva Brave responde (${livreB.length} conta(s))`, resolver: '' };
  }
  return {
    servico: 'busca',
    veredito: 'teto',
    detalhe: `as ${tavily.length} conta(s) Tavily e a reserva Brave estão no teto do mês`,
    resolver: 'o teto zera na virada do mês. Para antes disso: abra outra conta Tavily (outro email) e cadastre em Configurações → Chaves do projeto.',
  };
}

// O que impede o ciclo de trabalhar. Busca no teto NÃO impede: o motor ainda melhora página no ar com o que já
// tem em casa; sem IA, nada feito.
export const impedeTrabalhar = (cs: Checagem[]): Checagem | null => cs.find((c) => c.servico === 'ia' && c.veredito !== 'ok') ?? null;
export const algumProblema = (cs: Checagem[]): Checagem[] => cs.filter((c) => c.veredito !== 'ok');

// Camada 2: o ciclo terminou "sem nada a publicar" — foi falta de pauta ou o provedor recusando no meio?
// 28/10: as três etapas que produziriam cartão novo morreram com 402 e o resultado ficou igual ao de um ciclo
// tranquilo. Daqui em diante, o texto do resultado decide.
const MARCAS: { re: RegExp; servico: 'ia' | 'busca'; veredito: Veredito }[] = [
  { re: /\bHTTP 402\b|insufficient[_ ]?(credits|quota)/i, servico: 'ia', veredito: 'sem_credito' },
  { re: /NO_CREDENTIALS|NEXOS_API_KEY ausente|\bHTTP 40[13]\b/i, servico: 'ia', veredito: 'credencial' },
  { re: /cota do plano Tavily esgotada|teto mensal de .* créditos|teto mensal Tavily/i, servico: 'busca', veredito: 'teto' },
];

export function provedorNoTexto(texto: string): Checagem | null {
  for (const m of MARCAS) {
    const hit = m.re.exec(texto);
    if (!hit) continue;
    const base = m.servico === 'ia'
      ? m.veredito === 'sem_credito'
        ? { resolver: 'compre crédito na Hostinger, em Faturamento. O saldo da tela de IA não é o que o AI Router gasta.' }
        : { resolver: 'confira a chave de IA em Configurações → Chaves do projeto' }
      : { resolver: 'o teto zera na virada do mês; antes disso, outra conta Tavily resolve' };
    return { servico: m.servico, veredito: m.veredito, detalhe: `o ciclo terminou sem publicar e o motivo aparece no resultado: "${hit[0]}"`, ...base };
  }
  return null;
}

export interface Retrato {
  at: string;
  ok: boolean;
  checagens: Checagem[];
}

export async function preflight(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Retrato> {
  const checagens = [await checarIa(fetchImpl), checarBusca()];
  const r: Retrato = { at: now.toISOString(), ok: !impedeTrabalhar(checagens), checagens };
  try {
    writeState('preflight.json', r); // o painel mostra isto sem repetir a chamada
  } catch {
    /* registro nunca derruba a checagem */
  }
  return r;
}
