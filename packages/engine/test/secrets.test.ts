import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-cofre-'));
process.env.TAVILY_API_KEY = 'tvly-do-servidor-1234567890';
process.env.NEXOS_API_KEY = 'sk-do-servidor-1234567890';

const { addKey, addService, keysOf, maskKey, removeKey, removeService, secret, services, vaultBackup } = await import('../src/secrets.ts');
const zera = () => rmSync(join(process.env.BEM_STATE_DIR!, 'keys.json'), { force: true });

// 28/10, pedido do editor: "um repositório universal do projeto… cada vez menos usar essa instância do Claude e
// cada vez mais fazer tudo pelo admin". A chave do servidor nunca sai pelo painel.
describe('cofre de chaves do projeto', () => {
  beforeEach(zera);

  it('a chave do servidor aparece e não pode ser removida pelo painel', () => {
    expect(keysOf('tavily')[0]!.id).toBe('env');
    expect(removeKey('tavily', 'env')).toBeNull();
    expect(keysOf('tavily')).toHaveLength(1);
  });

  it('busca: a do servidor é usada primeiro e as novas entram como contas seguintes', () => {
    addKey('tavily', 'tvly-segunda-conta-0987654321', 'conta 2');
    addKey('tavily', 'tvly-terceira-conta-5555555555', 'conta 3');
    expect(keysOf('tavily').map((k) => k.label)).toEqual(['chave principal (no servidor)', 'conta 2', 'conta 3']);
    expect(secret('tavily')).toBe('tvly-do-servidor-1234567890');
  });

  // Serviço de uma chave só: cadastrar é trocar. Com a do servidor na frente, o cadastro não serviria para nada.
  it('modelos de IA: a chave nova cadastrada passa a valer na hora', () => {
    expect(secret('llm')).toBe('sk-do-servidor-1234567890');
    addKey('llm', 'sk-chave-nova-abcdefghij', 'chave nova');
    expect(secret('llm')).toBe('sk-chave-nova-abcdefghij');
    expect(keysOf('llm')[1]!.id).toBe('env'); // a do servidor continua como reserva
  });

  it('recusa chave com cara errada, e diz qual é a cara certa', () => {
    expect(addKey('llm', 'tvly-isto-e-da-tavily-123', 'x')).toContain('sk-');
    expect(addKey('tavily', 'sk-isto-e-do-router-123456', 'x')).toContain('tvly-');
  });

  it('não guarda a mesma chave duas vezes', () => {
    addKey('brave', 'BSAabcdefghij1234567890', 'conta 1');
    expect(addKey('brave', 'BSAabcdefghij1234567890', 'de novo')).toContain('já está cadastrada');
  });

  it('a chave nunca aparece inteira', () => {
    expect(maskKey('tvly-do-servidor-1234567890')).toBe('…7890');
    expect(maskKey('tvly-do-servidor-1234567890')).not.toContain('servidor');
  });

  // 28/10, 2ª pergunta do editor: "caso seja necessário mais chaves no futuro (amazon, própria VPS ou outra VPS
  // etc) consigo colocar?". Sim, e sem mexer em código.
  it('o editor cria um serviço novo e guarda a chave dele', () => {
    const sv = addService('amazon', 'Amazon PA-API', 'Associados', false);
    expect(typeof sv).not.toBe('string');
    expect(services().amazon!.custom).toBe(true);
    expect(addKey('amazon', 'qualquer-credencial-longa-o-bastante', 'conta principal')).not.toBe('string');
    expect(secret('amazon')).toBe('qualquer-credencial-longa-o-bastante');
  });

  it('serviço que o motor usa não sai pelo painel; o criado pelo editor sai', () => {
    expect(removeService('tavily')).toBeNull();
    addService('vps-2', 'Outra VPS', 'Hostinger', false);
    expect(removeService('vps-2')).toBe('Outra VPS');
    expect(services()['vps-2']).toBeUndefined();
  });

  it('apelido repetido e apelido curto demais são recusados', () => {
    addService('amazon', 'Amazon', 'x', false);
    expect(addService('amazon', 'Amazon de novo', 'x', false)).toContain('já existe');
    expect(addService('!', 'X', 'x', false)).toContain('apelido curto');
  });

  // O cofre vive só na VPS: sem cópia fora dela, perder a máquina é perder as chaves.
  it('a cópia de segurança traz as chaves do cofre e as do servidor, com onde restaurar', () => {
    addKey('tavily', 'tvly-segunda-conta-0987654321', 'conta 2');
    const b = JSON.parse(vaultBackup());
    expect(b.chaves_do_cofre.tavily[0].key).toBe('tvly-segunda-conta-0987654321');
    expect(b.chaves_no_servidor.tavily.valor).toBe('tvly-do-servidor-1234567890');
    expect(b.onde_restaurar.servidor).toContain('/etc/bem-apoiado/env');
    expect(b.aviso).toContain('CHAVES EM TEXTO');
  });
});
