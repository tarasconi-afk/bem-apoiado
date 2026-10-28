import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TopicBrief } from '@bem-apoiado/core';
import { loadTopic } from './research.ts';
import { research } from './research.ts';
import { classify, loadRegistry, snapshotOrTavily } from './discover.ts';
import { TOPICS_DIR, writeJson } from '../store.ts';

// Fonte indicada pelo editor (28/10). Quando a busca automática não acha o documento, o motor já dizia
// "só um fabricante ou fonte indicada por você resolve" — e não havia como indicar: o painel só aprovava ou
// bloqueava domínio. A saída prometida não existia, e a única alternativa era eu entrar na VPS, que é o
// oposto do que o projeto quer.
//
// Caso que motivou: a etiquetagem têxtil do Inmetro (lavagem, secagem, composição) responde perguntas de 29
// das 80 pautas da fila, e a busca não tinha trazido o documento.
//
// O cadastro de domínios continua mandando: URL de domínio desconhecido NÃO entra por aqui. Aprovar domínio
// é decisão à parte, que o painel já tem, e misturar as duas transformaria este campo num jeito de contornar
// a checagem de procedência.

export interface IndicatedResult {
  ok: boolean;
  message: string;
  source_id?: string;
  evidence?: number;
}

export async function addIndicatedSource(slug: string, url: string, runId: string): Promise<IndicatedResult> {
  let topic: TopicBrief;
  try {
    topic = loadTopic(slug);
  } catch (e) {
    // Pauta inexistente e pauta ilegível davam a mesma mensagem, e o editor ficaria procurando um erro de
    // digitação num arquivo quebrado. Dizer qual dos dois é poupa a busca errada.
    const arquivo = join(TOPICS_DIR, `${slug}.json`);
    return existsSync(arquivo)
      ? { ok: false, message: `a pauta "${slug}" existe mas está ilegível: ${(e as Error).message.slice(0, 120)}` }
      : { ok: false, message: `não existe pauta "${slug}"` };
  }
  let limpa: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocolo');
    limpa = u.toString();
  } catch {
    return { ok: false, message: 'endereço inválido: cole a URL inteira, começando com https://' };
  }
  const reg = loadRegistry();
  const c = classify(limpa, reg);
  const host = new URL(limpa).hostname.replace(/^www\./, '');
  if (c === 'blocked') return { ok: false, message: `o domínio ${host} está bloqueado no cadastro; desbloqueie antes, se for o caso` };
  if (c === 'unknown') {
    return {
      ok: false,
      message: `o domínio ${host} não está no cadastro de fontes. Aprove-o primeiro em Conteúdo → domínios (é lá que se diz de quem é o site e que tipo de fonte ele é); depois indique a URL de novo.`,
    };
  }
  let source;
  try {
    ({ source } = await snapshotOrTavily({ url: limpa, publisher: c.publisher, sourceClass: c.source_class }));
  } catch (e) {
    return { ok: false, message: `não deu para ler a página: ${(e as Error).message.slice(0, 160)}` };
  }
  const antes = topic.source_ids.length;
  const ids = [...new Set([...topic.source_ids, source.id])];
  writeJson(join(TOPICS_DIR, `${slug}.json`), TopicBrief.parse({ ...topic, source_ids: ids }));
  if (ids.length === antes) {
    return { ok: true, source_id: source.id, evidence: 0, message: `essa fonte já estava ligada à pauta "${slug}" (${c.publisher}); nada mudou` };
  }
  // Extrai só desta fonte: o resto da pauta já foi lido, e reler tudo gastaria à toa.
  const r = await research(slug, runId, undefined, [source.id]);
  const n = r.accepted.length;
  return {
    ok: true,
    source_id: source.id,
    evidence: n,
    message: n
      ? `fonte de ${c.publisher} lida e ligada a "${slug}": ${n} evidência(s) nova(s). A página é reescrita com elas no enriquecimento, e o resultado vem para o quadro.`
      : `fonte de ${c.publisher} lida e guardada, mas nenhum trecho dela respondeu às perguntas desta pauta. Ela fica no acervo para outras pautas.`,
  };
}
