import { existsSync } from 'node:fs';

// Credenciais do motor: variáveis de ambiente, com fallback para o arquivo da VPS. Nunca no repositório.
// Importado primeiro por quem precisa de chave (LLM, busca), para não depender da ordem dos imports.
const ENV_FILE = '/etc/bem-apoiado/env';
// Nunca nos testes (23/10: na VPS, os testes do gate antes de publicar carregavam a chave real da Brave, a reserva
// entrava no lugar do erro esperado e a publicação de uma página aprovada falhou duas vezes).
if (!process.env.VITEST && existsSync(ENV_FILE) && (!process.env.NEXOS_API_KEY || !process.env.TAVILY_API_KEY || !process.env.BRAVE_API_KEY)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // sem permissão de leitura (ex.: rodando como outro usuário): segue só com o ambiente
  }
}
export const ENV_FILE_PATH = ENV_FILE;
