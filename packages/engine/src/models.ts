// Papéis fixos. Redator e auditor são de fornecedores diferentes de propósito (ver docs/DECISIONS.md).
// IDs = os que GET /models do Hostinger AI Router devolve para a nossa chave (o catálogo do painel
// é maior que o da chave; conferir com `curl $NEXOS_BASE_URL/models` antes de trocar).
//
// Preço em CRÉDITOS HOSTINGER por 1M tokens (entrada, saída). O painel mostra o preço na unidade
// antiga da nexos; 1 crédito nexos = 100 créditos Hostinger (migração de out/2026). Erro de unidade
// aqui já custou caro uma vez: conferir contra o extrato do hPanel ao trocar de modelo.
export const MODELS = {
  // Propõe trechos candidatos das fontes. Barato: o código confere a literalidade depois.
  extractor: { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', vendor: 'anthropic', price: [100, 500] },
  // Escreve o PageSpec a partir só dos claims aprovados. Sonnet 5: 2,5x mais barato que o Opus 5.
  writer: { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'anthropic', price: [200, 1000] },
  // Julga se cada bloco é sustentado pelos trechos citados. Outro fornecedor que o redator.
  auditor: { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', vendor: 'openai', price: [400, 2000] },
} as const;

export type Role = keyof typeof MODELS;

export function creditsFor(role: Role, usage: { input_tokens: number; output_tokens: number }): number {
  const [pin, pout] = MODELS[role].price;
  return (usage.input_tokens * pin + usage.output_tokens * pout) / 1_000_000;
}

if ((MODELS.writer.vendor as string) === (MODELS.auditor.vendor as string)) {
  throw new Error('redator e auditor precisam ser de fornecedores diferentes');
}
