// LADOS DA DECISÃO (13/11/2026). "Pillow top ou topper" foi escrita com 73 evidências e NENHUMA dizia "topper": a
// checagem antes da redação aceitou 2 regras em que um pillow top da Luuna fazia o papel de topper, a página saiu
// reprovada ("não apresenta um topper vendido como peça avulsa"), e a correção automática pagou e não subiu a nota
// (1,5 → 1,5), porque falta fonte e não texto. Regra determinística, portada do motor FC (viabilidade.ts, 29/10):
// pauta "A ou B" só vai ao redator se CADA lado aparecer nas evidências da própria pauta. Não julga a qualidade da
// evidência (isso é da checagem e da auditoria); só barra a comparação com um lado vazio.
const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/-/g, ' ');
const VAZIAS = new Set(['de', 'do', 'da', 'dos', 'das', 'para', 'com', 'sem', 'qual', 'quais', 'melhor', 'um', 'uma', 'o', 'a', 'e', 'em', 'no', 'na']);
const palavras = (t: string) => norm(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !VAZIAS.has(w));

// "pillow top ou topper: diferença" → ["pillow top", "topper"]. Sem " ou " (ou com 1 lado) → [].
export function ladosDaPergunta(query: string): string[] {
  const pergunta = query.split(':')[0]!.replace(/\?/g, '');
  const lados = pergunta.split(/\s+ou\s+/i).map((s) => s.trim()).filter(Boolean);
  return lados.length >= 2 ? lados : [];
}

// Palavras que distinguem cada lado (as que o outro lado não tem); se não sobrar nenhuma, as do próprio lado.
function distintivas(lados: string[]): string[][] {
  const ws = lados.map(palavras);
  return ws.map((w, i) => {
    const outras = new Set(ws.filter((_, j) => j !== i).flat());
    const proprias = w.filter((x) => !outras.has(x));
    return proprias.length ? proprias : w;
  });
}

// Lados sem nenhuma evidência (radical da palavra distintiva no começo de uma palavra do trecho).
export function ladosSemEvidencia(query: string, trechos: string[]): string[] {
  const lados = ladosDaPergunta(query);
  if (!lados.length) return [];
  const corpo = ` ${norm(trechos.join(' '))}`;
  const dist = distintivas(lados);
  // Radical: tira as 2 últimas letras de palavra longa ("viscoelástico" casa "viscoelástica"; 13/11, o travesseiro de
  // látex ou viscoelástico, no ar, seria barrado pela forma feminina).
  const radical = (w: string) => (w.length >= 6 ? w.slice(0, -2) : w);
  return lados.filter((_, i) => !dist[i]!.some((w) => new RegExp(`[^a-z0-9]${radical(w)}`).test(corpo)));
}
