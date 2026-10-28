import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import './env.ts';
import { ROOT } from './store.ts';

// Cofre de chaves do projeto (28/10, pedido do editor: "um repositório universal do projeto… cada vez menos usar
// essa instância do Claude e cada vez mais fazer tudo pelo admin"). Toda chave que o motor usa pode ser cadastrada
// pelo painel, sem entrar na VPS e sem passar por mim.
//
// Onde fica: /var/lib/bem-apoiado/keys.json, fora do git, só para o usuário do motor (600).
// Como é lido: o cofre vem ANTES da variável de ambiente. A chave de /etc/bem-apoiado/env continua valendo como
// a de sempre, então nada quebra em quem já tem só ela, e ela nunca pode ser apagada pelo painel.
// Serviço com cota mensal por conta (busca) aceita VÁRIAS chaves e usa uma por vez; o resto usa a primeira.

const STATE_DIR = process.env.BEM_STATE_DIR ?? (existsSync('/var/lib/bem-apoiado') ? '/var/lib/bem-apoiado' : join(ROOT, '.state'));
const VAULT = () => join(STATE_DIR, 'keys.json');
// Arquivo da primeira versão, só da Tavily (28/10, manhã). Lido uma vez para a chave cadastrada não se perder.
const OLD_TAVILY = () => join(STATE_DIR, 'tavily-keys.json');

export const SERVICES = ['tavily', 'brave', 'llm'] as const;
export type Service = (typeof SERVICES)[number];

export interface ServiceInfo {
  label: string;
  env: string; // variável de ambiente equivalente (a chave "de sempre", que fica no servidor)
  multiple: boolean; // aceita várias contas, usadas uma por vez quando há cota mensal
  pattern: RegExp;
  hint: string;
  where: string;
}

export const SERVICE: Record<Service, ServiceInfo> = {
  tavily: { label: 'Tavily (busca na web)', env: 'TAVILY_API_KEY', multiple: true, pattern: /^tvly-[A-Za-z0-9_-]{10,}$/, hint: 'começa com tvly-', where: 'app.tavily.com, em API Keys' },
  brave: { label: 'Brave Search (reserva da Tavily)', env: 'BRAVE_API_KEY', multiple: true, pattern: /^[A-Za-z0-9_-]{20,}$/, hint: 'código de 20 ou mais caracteres', where: 'api-dashboard.search.brave.com' },
  llm: { label: 'Hostinger AI Router (modelos de IA)', env: 'NEXOS_API_KEY', multiple: false, pattern: /^sk-[A-Za-z0-9_-]{16,}$/, hint: 'começa com sk-', where: 'hPanel, em IA' },
};

export interface VaultKey { id: string; key: string; label: string; added_at: string }
type Vault = Partial<Record<Service, VaultKey[]>>;

function read(): Vault {
  const v: Vault = existsSync(VAULT()) ? JSON.parse(readFileSync(VAULT(), 'utf8')) : {};
  // Migração do arquivo antigo: acontece uma vez e só acrescenta.
  if (!existsSync(VAULT()) && existsSync(OLD_TAVILY())) {
    const old = (JSON.parse(readFileSync(OLD_TAVILY(), 'utf8')).keys ?? []) as VaultKey[];
    if (old.length) {
      v.tavily = old;
      write(v);
    }
  }
  return v;
}

function write(v: Vault): void {
  mkdirSync(dirname(VAULT()), { recursive: true });
  writeFileSync(`${VAULT()}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(`${VAULT()}.tmp`, VAULT());
}

// Ordem de uso, que é a ordem em que a lista aparece no painel.
// Serviço com cota por conta (busca): a chave do servidor primeiro e as do cofre depois, porque todas vão ser
// usadas e o rodízio só passa adiante quando a anterior esgota.
// Serviço de uma chave só (modelos de IA): a MAIS NOVA do cofre primeiro. Se o editor cadastra uma chave nova é
// porque quer trocar; deixar a do servidor na frente faria o cadastro não servir para nada.
export function keysOf(s: Service): VaultKey[] {
  const env = process.env[SERVICE[s].env];
  const doServidor = env ? [{ id: 'env', key: env, label: 'chave principal (no servidor)', added_at: '' }] : [];
  const vault = (read()[s] ?? []).filter((k) => k.key !== env);
  return SERVICE[s].multiple ? [...doServidor, ...vault] : [...[...vault].reverse(), ...doServidor];
}

// O que o motor usa quando não há rodízio por cota: a primeira que existir.
export const secret = (s: Service): string | undefined => keysOf(s)[0]?.key;

// Nunca devolve a chave inteira: o painel mostra só o fim, para o editor reconhecer qual é.
export const maskKey = (k: string) => `…${k.slice(-4)}`;

export function addKey(s: Service, key: string, label: string, now = new Date()): VaultKey | string {
  const k = key.trim();
  if (!SERVICE[s].pattern.test(k)) return `a chave do ${SERVICE[s].label} ${SERVICE[s].hint}; confira se copiou inteira`;
  if (keysOf(s).some((x) => x.key === k)) return 'essa chave já está cadastrada';
  const v = read();
  const fresh: VaultKey = { id: `k_${createHash('sha1').update(k).digest('hex').slice(0, 8)}`, key: k, label: label.trim().slice(0, 40) || 'conta extra', added_at: now.toISOString() };
  v[s] = [...(v[s] ?? []), fresh];
  write(v);
  return fresh;
}

export function removeKey(s: Service, id: string): string | null {
  if (id === 'env') return null; // a do servidor sai de /etc/bem-apoiado/env, não daqui
  const v = read();
  const hit = (v[s] ?? []).find((k) => k.id === id);
  if (!hit) return null;
  v[s] = (v[s] ?? []).filter((k) => k !== hit);
  write(v);
  return hit.label;
}
