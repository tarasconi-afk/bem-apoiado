import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import './env.ts';
import { ROOT } from './store.ts';

// Cofre de chaves do projeto (28/10, pedido do editor: "um repositório universal do projeto… cada vez menos usar
// essa instância do Claude e cada vez mais fazer tudo pelo admin"). Toda chave que o motor usa, e também as que
// ele ainda não usa, podem ser cadastradas pelo painel, sem entrar na VPS e sem passar por mim.
//
// Onde fica: /var/lib/bem-apoiado/keys.json, fora do git, só para o usuário do motor (600).
// Como é lido: o cofre vem ANTES da variável de ambiente. A chave de /etc/bem-apoiado/env continua valendo como a
// de sempre, e o painel nunca a remove.
//
// SERVIÇO NOVO SEM MEXER EM CÓDIGO (28/10, 2ª pergunta do editor: "caso seja necessário mais chaves no futuro
// (amazon, própria VPS ou outra VPS etc) consigo colocar?"). O editor cria o serviço pelo painel; ele entra no
// cofre como qualquer outro e fica guardado, visível e recuperável. Serviço que o motor ainda não consulta serve
// como lugar seguro para a credencial — e no dia em que algum código precisar dela, secret('<id>') já devolve.

const STATE_DIR = process.env.BEM_STATE_DIR ?? (existsSync('/var/lib/bem-apoiado') ? '/var/lib/bem-apoiado' : join(ROOT, '.state'));
const VAULT = () => join(STATE_DIR, 'keys.json');
// Arquivo da primeira versão, só da Tavily (28/10, manhã). Lido uma vez para a chave cadastrada não se perder.
const OLD_TAVILY = () => join(STATE_DIR, 'tavily-keys.json');

export interface ServiceInfo {
  label: string;
  env?: string; // variável de ambiente equivalente (a chave "de sempre", que fica no servidor)
  multiple: boolean; // aceita várias contas, usadas uma por vez quando há cota mensal
  pattern?: string; // expressão de conferência; sem ela, qualquer texto com 8 a 200 caracteres serve
  hint: string;
  where: string;
  used?: string; // o que no motor usa esta chave; vazio = guardada para o futuro
  custom?: boolean;
}

// Serviços que o motor consulta. Estes não podem ser removidos pelo painel: há código dependendo deles.
export const BUILTIN: Record<string, ServiceInfo> = {
  tavily: { label: 'Tavily (busca na web)', env: 'TAVILY_API_KEY', multiple: true, pattern: '^tvly-[A-Za-z0-9_-]{10,}$', hint: 'começa com tvly-', where: 'app.tavily.com, em API Keys', used: 'pesquisa de fontes e leitura de anúncios' },
  brave: { label: 'Brave Search (reserva da Tavily)', env: 'BRAVE_API_KEY', multiple: true, pattern: '^[A-Za-z0-9_-]{20,}$', hint: 'código de 20 ou mais caracteres', where: 'api-dashboard.search.brave.com', used: 'busca, quando a cota da Tavily acaba' },
  llm: { label: 'Hostinger AI Router (modelos de IA)', env: 'NEXOS_API_KEY', multiple: false, pattern: '^sk-[A-Za-z0-9_-]{16,}$', hint: 'começa com sk-', where: 'hPanel, em IA', used: 'redator, auditor, juiz e imagens' },
};

export type Service = string;
export interface VaultKey { id: string; key: string; label: string; added_at: string }
interface Vault { keys?: Record<string, VaultKey[]>; services?: Record<string, ServiceInfo> }

function read(): Vault {
  if (!existsSync(VAULT())) {
    // Migração do arquivo antigo (só Tavily): acontece uma vez e só acrescenta.
    if (existsSync(OLD_TAVILY())) {
      const old = (JSON.parse(readFileSync(OLD_TAVILY(), 'utf8')).keys ?? []) as VaultKey[];
      if (old.length) {
        const v: Vault = { keys: { tavily: old } };
        write(v);
        return v;
      }
    }
    return {};
  }
  const raw = JSON.parse(readFileSync(VAULT(), 'utf8')) as Vault & Record<string, unknown>;
  // Formato da manhã de 28/10: as listas ficavam na raiz, sem a chave "keys".
  if (!raw.keys && !raw.services) return { keys: raw as unknown as Record<string, VaultKey[]> };
  return raw;
}

function write(v: Vault): void {
  mkdirSync(dirname(VAULT()), { recursive: true });
  writeFileSync(`${VAULT()}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(`${VAULT()}.tmp`, VAULT());
}

// Todos os serviços: os que o motor usa e os que o editor criou.
export function services(): Record<string, ServiceInfo> {
  return { ...BUILTIN, ...(read().services ?? {}) };
}

export const SERVICE = services; // nome curto usado no painel

export function addService(id: string, label: string, where: string, multiple: boolean): ServiceInfo | string {
  const key = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  if (key.length < 2) return 'dê um apelido curto ao serviço, só com letras e números (ex.: amazon, vps-2)';
  if (services()[key]) return `já existe um serviço chamado "${key}"`;
  const v = read();
  const info: ServiceInfo = { label: label.trim().slice(0, 60) || key, multiple, hint: 'o código que o serviço fornece', where: where.trim().slice(0, 80) || 'painel do próprio serviço', custom: true };
  v.services = { ...(v.services ?? {}), [key]: info };
  write(v);
  return info;
}

export function removeService(id: string): string | null {
  if (BUILTIN[id]) return null; // há código usando: sai pelo desenvolvedor, não pelo painel
  const v = read();
  const info = (v.services ?? {})[id];
  if (!info) return null;
  delete v.services![id];
  delete (v.keys ?? {})[id];
  write(v);
  return info.label;
}

// Ordem de uso, que é a ordem em que a lista aparece no painel.
// Serviço com cota por conta (busca): a chave do servidor primeiro e as do cofre depois, porque todas vão ser
// usadas e o rodízio só passa adiante quando a anterior esgota.
// Serviço de uma chave só: a MAIS NOVA do cofre primeiro. Se o editor cadastra uma chave nova é porque quer
// trocar; deixar a do servidor na frente faria o cadastro não servir para nada.
export function keysOf(s: Service): VaultKey[] {
  const info = services()[s];
  const env = info?.env ? process.env[info.env] : undefined;
  const doServidor = env ? [{ id: 'env', key: env, label: 'chave principal (no servidor)', added_at: '' }] : [];
  const vault = (read().keys ?? {})[s] ?? [];
  const extras = vault.filter((k) => k.key !== env);
  return info?.multiple ? [...doServidor, ...extras] : [...[...extras].reverse(), ...doServidor];
}

// O que o motor usa quando não há rodízio por cota: a primeira que existir.
export const secret = (s: Service): string | undefined => keysOf(s)[0]?.key;

// Nunca devolve a chave inteira: o painel mostra só o fim, para o editor reconhecer qual é.
export const maskKey = (k: string) => `…${k.slice(-4)}`;

export function addKey(s: Service, key: string, label: string, now = new Date()): VaultKey | string {
  const info = services()[s];
  if (!info) return 'serviço desconhecido';
  const k = key.trim();
  const ok = info.pattern ? new RegExp(info.pattern).test(k) : k.length >= 8 && k.length <= 200;
  if (!ok) return `a chave de ${info.label} ${info.hint}; confira se copiou inteira`;
  if (keysOf(s).some((x) => x.key === k)) return 'essa chave já está cadastrada';
  const v = read();
  const fresh: VaultKey = { id: `k_${createHash('sha1').update(k).digest('hex').slice(0, 8)}`, key: k, label: label.trim().slice(0, 40) || 'conta extra', added_at: now.toISOString() };
  v.keys = { ...(v.keys ?? {}), [s]: [...((v.keys ?? {})[s] ?? []), fresh] };
  write(v);
  return fresh;
}

export function removeKey(s: Service, id: string): string | null {
  if (id === 'env') return null; // a do servidor sai de /etc/bem-apoiado/env, não daqui
  const v = read();
  const hit = ((v.keys ?? {})[s] ?? []).find((k) => k.id === id);
  if (!hit) return null;
  v.keys = { ...(v.keys ?? {}), [s]: ((v.keys ?? {})[s] ?? []).filter((k) => k !== hit) };
  write(v);
  return hit.label;
}

// Cópia de segurança do cofre, para baixar pelo painel (28/10, editor: "tudo recuperável caso eu perca acesso").
// O cofre vive só na VPS; sem uma cópia fora dela, perder a máquina é perder as chaves. Traz as do cofre e os
// NOMES das que ficam no servidor, com instrução de onde cada uma entra de volta.
export function vaultBackup(now = new Date()): string {
  const v = read();
  const svc = services();
  return JSON.stringify({
    aviso: 'CONTÉM CHAVES EM TEXTO. Guarde num gerenciador de senhas, nunca no git nem por email.',
    gerado_em: now.toISOString(),
    onde_restaurar: {
      cofre: `${VAULT()} (dono do motor, permissão 600)`,
      servidor: '/etc/bem-apoiado/env (root:bemapoiado, 640) para as chaves marcadas como "no servidor"',
    },
    servicos: Object.fromEntries(Object.entries(svc).map(([id, i]) => [id, { nome: i.label, onde_pegar: i.where, variavel_no_servidor: i.env ?? null, usado_em: i.used ?? 'guardada para o futuro' }])),
    chaves_do_cofre: v.keys ?? {},
    chaves_no_servidor: Object.fromEntries(Object.entries(svc).filter(([, i]) => i.env && process.env[i.env]).map(([id, i]) => [id, { variavel: i.env, valor: process.env[i.env!] }])),
  }, null, 2);
}
