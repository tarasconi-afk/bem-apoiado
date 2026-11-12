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

// Citação literal sem alegação de saúde (12/11, auditoria: "alinhamento da coluna", "antialérgico", "médicos recomendam"
// impressos na seção Fontes de 10 páginas). A regra do nicho vale para o texto; a quote saía sem filtro. Tira só a(s)
// frase(s) com termo vetado; o renderer sinaliza a omissão. Nomes de modelo e peças ("NASA X Cervical", "Pró Saúde",
// "Anatomic Visco", "apoio lombar ajustável") não são alegação: esses termos ficam fora do filtro de citação.
export const CITACAO_IGNORA = ['lombar', 'cervical', 'anatomic', 'anatômic', 'saúde'];
const CITACAO_EXTRA = ['médic', 'fisioterap'];
// 12/11: "cervical" fica fora da lista por causa de nomes de modelo ("NASA X Cervical"), mas "apoio cervical", "região
// cervical" e "coluna cervical" numa citação são alegação de postura/saúde, não nome: entram pelo contexto.
const CITACAO_CONTEXTO = [/\b(apoio|regiao|região|coluna|suporte)\s+cervical/iu, /\balinhamento\s+(da\s+)?(coluna|postural)/iu];
export function citacaoSemAlegacao(quote: string, forbidden: string[]): { texto: string; omitidas: number } {
  const terms = [...forbidden.filter((t) => !CITACAO_IGNORA.includes(normalizeForMatch(t)) && !CITACAO_IGNORA.includes(t)), ...CITACAO_EXTRA];
  const frases = quote.split(/(?<=[.!?;])\s+/);
  const ok = frases.filter((f) => !firstForbidden(f, terms) && !CITACAO_CONTEXTO.some((re) => re.test(f)));
  return { texto: ok.join(' ').trim(), omitidas: frases.length - ok.length };
}
