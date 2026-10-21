import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'bem-loc-'));
process.env.BEM_ROOT = root;
writeFileSync(join(root, 'package.json'), '{"name":"bem-apoiado"}');
mkdirSync(join(root, 'data/sources/src_aaaaaaaaaaaa'), { recursive: true });
const text = ['SUMÁRIO', 'Anexo I - Checkout', 'Anexo II - Trabalho em Teleatendimento', '17.1 Esta Norma visa estabelecer as diretrizes gerais do trabalho.', 'texto', 'ANEXO I', 'CHECKOUT', 'regras do caixa', 'ANEXO II', 'TRABALHO EM TELEATENDIMENTO/TELEMARKETING', 'altura ajustável entre 37 e 50 centímetros'].join('\n');
writeFileSync(join(root, 'data/sources/src_aaaaaaaaaaaa/text.txt'), text);
const src = { id: 'src_aaaaaaaaaaaa', text_file: 'data/sources/src_aaaaaaaaaaaa/text.txt', final_url: 'https://gov.br/nr-17.pdf', title: null } as never;

describe('parte do documento onde está o trecho', () => {
  it('anexo com o título da linha seguinte; texto principal quando o anexo só aparece no sumário', async () => {
    const { quoteLocation } = await import('../src/stages/write.ts');
    expect(quoteLocation(src, 'altura ajustável entre 37 e 50 centímetros')).toBe('ANEXO II · TRABALHO EM TELEATENDIMENTO/TELEMARKETING');
    expect(quoteLocation(src, 'Esta Norma visa estabelecer as diretrizes gerais')).toBe('texto principal (antes de ANEXO I)');
  });
});
