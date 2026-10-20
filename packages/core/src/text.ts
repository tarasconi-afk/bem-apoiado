// Normalização usada para comparar citações com o texto da fonte.
// Tolera só diferenças tipográficas e de espaçamento; nunca diferenças de palavras ou números.
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/­/g, '') // hífen suave
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length === 0) return false;
  return normalizeForMatch(sourceText).includes(q);
}
