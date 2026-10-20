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

// Posição do primeiro termo proibido no texto (-1 se nenhum). Termo curto (até 4 letras, ex.: "dor")
// só conta como palavra inteira, para não casar com "vendedor" ou "edredom"; termo longo vale como prefixo.
export function firstForbidden(text: string, terms: string[]): { index: number; term: string } | null {
  const t = normalizeForMatch(text);
  let best: { index: number; term: string } | null = null;
  for (const raw of terms) {
    const term = normalizeForMatch(raw);
    const re = term.length <= 4 ? new RegExp(`(^|[^\\p{L}])${term}($|[^\\p{L}])`, 'u') : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
    const m = re.exec(t);
    if (m) {
      const index = term.length <= 4 ? m.index + m[1]!.length : m.index;
      if (!best || index < best.index) best = { index, term };
    }
  }
  return best;
}
