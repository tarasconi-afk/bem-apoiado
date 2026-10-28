import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.BEM_STATE_DIR = mkdtempSync(join(tmpdir(), 'bem-cofre-'));
process.env.TAVILY_API_KEY = 'tvly-do-servidor-1234567890';
process.env.NEXOS_API_KEY = 'sk-do-servidor-1234567890';

const { addKey, keysOf, maskKey, removeKey, secret } = await import('../src/secrets.ts');
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
});
