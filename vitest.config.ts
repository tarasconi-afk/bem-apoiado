import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Testes nunca tocam o estado real da VPS (livro-caixa, tetos, chaves): cada execução tem o seu diretório.
export default defineConfig({
  test: {
    env: { BEM_STATE_DIR: mkdtempSync(join(tmpdir(), 'bem-test-state-')), BEM_RETRY_MS: '0' },
  },
});
