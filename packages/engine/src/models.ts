// Papéis fixos. Redator e auditor são de fornecedores diferentes de propósito (ver docs/DECISIONS.md).
// IDs = UUIDs do painel Nexos (IA Roteador), estáveis mesmo se o nome de exibição mudar.
export const MODELS = {
  // Propõe trechos candidatos das fontes. Barato: o código confere a literalidade depois.
  extractor: { id: '7a95fe1a-e9a2-43ba-8c4d-ccecf6392e01', name: 'Claude Haiku 5.5', vendor: 'anthropic' },
  // Escreve o PageSpec a partir só dos claims aprovados.
  writer: { id: 'f213234f-b7a5-4927-aaad-d97d2f517426', name: 'Claude Opus 5.5', vendor: 'anthropic' },
  // Julga se cada bloco é sustentado pelos trechos citados. Outro fornecedor que o redator.
  auditor: { id: '7413e47f-7eaa-4d57-b013-fbf64ed4381b', name: 'GPT 6.1 Sol', vendor: 'openai' },
} as const;

export type Role = keyof typeof MODELS;

if ((MODELS.writer.vendor as string) === (MODELS.auditor.vendor as string)) {
  throw new Error('redator e auditor precisam ser de fornecedores diferentes');
}
