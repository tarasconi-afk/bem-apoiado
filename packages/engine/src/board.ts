// Quadro de decisões do painel (22/10, editor: "muitas informações juntas, muitos cliques; não sabia se o ciclo
// gerou algo aprovado, não aprovado, o que fazer"). Cada cartão responde sempre às mesmas perguntas: o que é,
// em que situação está, o que o motor sugere e por quê, e qual é o clique. Aqui só a classificação (pura,
// testável); o desenho fica no admin.

export type CardKind = 'pagina-nova' | 'ajuste-no-ar' | 'manutencao' | 'pauta-tentada' | 'rascunho';
export type Suggestion = 'publicar' | 'aplicar' | 'aprovar' | 'corrigir' | 'recusar' | 'nada';

export interface CardInfo {
  kind: CardKind;
  situation: string;
  suggestion: Suggestion;
  why: string;
  correction: string; // texto pronto para "Pedir correção" (vazio = nada a sugerir)
}

export interface ReviewLike {
  publishable: boolean;
  answers_primary_query?: string;
  reader_fit?: boolean;
  quick_answer?: boolean;
  purchase_path?: boolean;
  missing?: string[];
  reader_problems?: string[];
}

export const KIND_LABEL: Record<CardKind, string> = {
  'pagina-nova': 'Página nova',
  'ajuste-no-ar': 'Mudança em página no ar',
  manutencao: 'Manutenção do site',
  'pauta-tentada': 'Pauta tentada',
  rascunho: 'Rascunho para seu veredito',
};

export const SUGGESTION_LABEL: Record<Suggestion, string> = {
  publicar: 'Publicar',
  aplicar: 'Aplicar',
  aprovar: 'Aprovar',
  corrigir: 'Corrigir antes',
  recusar: 'Recusar',
  nada: 'Nada a fazer',
};

// As 4 perguntas do padrão editorial, em uma linha.
export function fourQuestions(r: ReviewLike | null | undefined): string {
  if (!r) return 'sem revisão registrada';
  const yn = (b: boolean | undefined) => (b === false ? 'não' : 'sim');
  const dec = r.answers_primary_query === 'no' ? 'não' : r.answers_primary_query === 'partial' ? 'em parte' : 'sim';
  return `decide: ${dec} · leva à compra: ${yn(r.purchase_path)} · leigo: ${yn(r.reader_fit)} · resposta rápida: ${yn(r.quick_answer)}`;
}

// Pedido de correção pronto a partir do que a revisão apontou (o editor edita antes de mandar, se quiser).
export function correctionText(r: ReviewLike | null | undefined): string {
  if (!r) return '';
  // Só o que reescrever resolve: problemas de leitura e as 2 faltas de forma (resposta curta, o que conferir).
  // Falta de fonte ("norma da ABNT sobre firmeza") pede pesquisa, não correção de texto.
  const FORM = /^(Resposta curta que resolva|O que conferir no anúncio)/;
  const items = [...(r.reader_problems ?? []), ...(r.missing ?? []).filter((m) => FORM.test(m))]
    .map((x) => x.replace(/^Para o leitor leigo:\s*/, '').trim())
    .filter(Boolean);
  const uniq = [...new Set(items)].slice(0, 4);
  if (!uniq.length) return '';
  return `Corrija, só com o que as fontes sustentarem: ${uniq.map((x, i) => `${i + 1}) ${x}`).join(' ')}`.slice(0, 600);
}

export function classifyBranch(b: {
  slug: string;
  items: { id: string; title: string }[];
  query?: string;
  outcome: string | null;
  steps: string[];
  review: ReviewLike | null;
  failedAdjust: boolean;
}): CardInfo {
  const page = b.items.find((i) => i.id === `page:${b.slug}`);
  const correction = correctionText(b.review);
  if (page && /Página nova/.test(page.title)) {
    if (b.failedAdjust) return { kind: 'pagina-nova', situation: 'Pronta, mas o último ajuste que você pediu não foi salvo.', suggestion: 'corrigir', why: 'O ajuste não entrou; peça de novo ou publique assim mesmo.', correction };
    if (b.review && !b.review.publishable) return { kind: 'pagina-nova', situation: 'Passou na auditoria das fontes, mas a revisão de leitor achou pontos fracos.', suggestion: 'corrigir', why: fourQuestions(b.review), correction };
    return { kind: 'pagina-nova', situation: 'Pronta: aprovada pela auditoria das fontes e pela revisão de leitor.', suggestion: 'publicar', why: fourQuestions(b.review), correction };
  }
  if (page) {
    const st = b.steps.find((x) => x.includes(b.slug)) ?? '';
    const situation = /^resumo de/.test(st)
      ? 'O motor reescreveu a resposta curta para leigo, com as mesmas fontes.'
      : /^re-auditoria/.test(st)
        ? 'A re-auditoria corrigiu trechos que diziam mais do que as fontes.'
        : /^enriquecimento/.test(st)
          ? 'Fontes novas foram lidas e a página foi reescrita com elas.'
          : 'O seu ajuste está pronto para conferir.';
    if (b.failedAdjust) return { kind: 'ajuste-no-ar', situation: 'O último ajuste que você pediu não foi salvo.', suggestion: 'corrigir', why: 'Peça de novo; a página no ar continua como estava.', correction };
    return { kind: 'ajuste-no-ar', situation, suggestion: 'aplicar', why: 'A mudança passou na auditoria; confira o antes × depois.', correction: '' };
  }
  if (b.items.length) {
    const parts = [
      b.items.some((i) => i.id === 'images') ? 'imagem nova' : '',
      b.items.filter((i) => i.id.startsWith('product:')).length ? `${b.items.filter((i) => i.id.startsWith('product:')).length} produto(s)` : '',
      b.items.some((i) => i.id === 'anchors' || i.id === 'search-links') ? 'links' : '',
      b.items.some((i) => i.id === 'theme' || i.id === 'home') ? 'visual da home' : '',
    ].filter(Boolean);
    return { kind: 'manutencao', situation: `Mudanças de manutenção prontas: ${parts.join(', ') || 'itens do site'}.`, suggestion: 'aplicar', why: 'Aceite ou rejeite cada item abaixo; o resto entra junto.', correction: '' };
  }
  const deferred = b.steps.some((s) => s.startsWith('pauta adiada antes da redação'));
  const draft = b.steps.some((s) => /page: NOT_PUBLISHABLE|improve: página NOT_PUBLISHABLE/.test(s));
  return {
    kind: 'pauta-tentada',
    situation: deferred
      ? 'Adiada antes de escrever: as fontes encontradas não dizem ao leitor o que escolher. Não há página nem prévia.'
      : draft
        ? 'Virou rascunho fraco; em até 5 minutos ele aparece num cartão "Rascunho para seu veredito".'
        : b.outcome
          ? b.outcome.charAt(0).toUpperCase() + b.outcome.slice(1) + '.'
          : 'Não virou página neste ciclo.',
    suggestion: 'nada',
    why: deferred
      ? (/Falta: ([^.]+)/.exec(b.outcome ?? '')?.[1] ?? 'falta fonte com regra de escolha')
      : 'Nada a decidir: as fontes e evidências deste ciclo entram sozinhas em até 5 minutos, e a próxima tentativa parte delas.',
    correction: '',
  };
}

export function classifyDraft(d: { review: ReviewLike | null; failedAdjust: boolean }): CardInfo {
  const correction = correctionText(d.review);
  if (d.failedAdjust) return { kind: 'rascunho', situation: 'O último ajuste que você pediu não foi salvo.', suggestion: 'corrigir', why: 'Peça de novo antes de aprovar.', correction };
  if (d.review?.publishable) return { kind: 'rascunho', situation: 'A revisão de leitor aprova esta versão.', suggestion: 'aprovar', why: fourQuestions(d.review), correction };
  if (correction) return { kind: 'rascunho', situation: 'A revisão de leitor achou pontos fracos que dá para corrigir.', suggestion: 'corrigir', why: fourQuestions(d.review), correction };
  return { kind: 'rascunho', situation: 'A revisão de leitor reprova esta versão.', suggestion: 'recusar', why: fourQuestions(d.review), correction };
}

// Ordem do quadro: o que pede o seu clique primeiro; informativo por último.
export const SUGGESTION_ORDER: Suggestion[] = ['publicar', 'aplicar', 'aprovar', 'corrigir', 'recusar', 'nada'];
