// Papéis fixos. Redator e auditor são de fornecedores diferentes de propósito (ver docs/DECISIONS.md).
// IDs = os que GET /models do Hostinger AI Router devolve para a nossa chave (o catálogo do painel
// é maior que o da chave; conferir com `curl $NEXOS_BASE_URL/models` antes de trocar).
export const MODELS = {
  // Propõe trechos candidatos das fontes. Barato: o código confere a literalidade depois.
  extractor: { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', vendor: 'anthropic' },
  // Escreve o PageSpec a partir só dos claims aprovados.
  writer: { id: 'claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic' },
  // Julga se cada bloco é sustentado pelos trechos citados. Outro fornecedor que o redator.
  auditor: { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', vendor: 'openai' },
} as const;

export type Role = keyof typeof MODELS;

if ((MODELS.writer.vendor as string) === (MODELS.auditor.vendor as string)) {
  throw new Error('redator e auditor precisam ser de fornecedores diferentes');
}
