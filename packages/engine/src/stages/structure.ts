import type { Draft } from './draft-schema.ts';

// Mudanças de estrutura sem IA: o conteúdo (texto, fontes) não muda, só o lugar. Nada novo a auditar.

// O site mostra no topo a ÚLTIMA seção como "Como decidir". O redator às vezes põe "Como decidir" em primeiro e
// fecha com "O que conferir na etiqueta" (22/10, guia de densidades: a tabela por peso ficou escondida nos
// detalhes e o editor pediu para "transferir a tabela" para a seção do topo). Aqui ela vai para o fim.
const DECISION = /\bcomo decidir\b|\bdecidir\b/i;
export function decisionLast(d: Draft): Draft {
  const i = d.sections.findLastIndex((s) => s.id === 'como-decidir' || DECISION.test(s.heading));
  if (i < 0 || i === d.sections.length - 1) return d;
  const sections = [...d.sections];
  const [sec] = sections.splice(i, 1);
  return { ...d, sections: [...sections, sec!] };
}

export interface Move {
  ref: string; // secao#i (bloco ou tabela inteira)
  to: string; // id da seção de destino
  position: 'start' | 'end' | 'after_first';
}

// Move blocos entre seções (22/10: "suba a tabela para a seção X" virava parágrafo novo com o título da tabela,
// e a tabela ficava onde estava). Seção que fica vazia sai, se a página mantiver 3+ seções.
export function applyMoves(d: Draft, moves: Move[]): { draft: Draft; done: string[] } {
  const sections = d.sections.map((s) => ({ ...s, blocks: [...s.blocks] }));
  // Tira primeiro (do maior índice para o menor, para os refs não andarem), depois põe.
  const valid = moves.filter((m) => {
    const [sid, i] = m.ref.split('#');
    const s = sections.find((x) => x.id === sid);
    return s && sections.some((x) => x.id === m.to) && sid !== m.to && s.blocks[Number(i)] !== undefined;
  });
  const moving = new Set(valid.map((m) => m.ref));
  const grabbed: { m: Move; blocks: Draft['sections'][number]['blocks'] }[] = [];
  for (const m of [...valid].sort((a, b) => Number(b.ref.split('#')[1]) - Number(a.ref.split('#')[1]))) {
    const [sid, i] = m.ref.split('#');
    const s = sections.find((x) => x.id === sid)!;
    let at = Number(i);
    let n = 1;
    // Tabela leva junto o parágrafo curto que a apresenta logo antes (22/10, tamanhos: o editor citou "Confira a
    // ficha técnica do modelo… Tamanho Ortobom Gazin…" e só o parágrafo foi movido).
    const prev = s.blocks[at - 1];
    const short = (b?: Draft['sections'][number]['blocks'][number]) => !!b && b.kind !== 'table' && b.text.split(/\s+/).length <= 20;
    const next = s.blocks[at + 1];
    if (s.blocks[at]?.kind === 'table' && short(prev) && !moving.has(`${sid}#${at - 1}`)) { at -= 1; n = 2; }
    // E o contrário: o editor (e o seletor) apontam o parágrafo de abertura; a tabela logo depois vai junto.
    else if (short(s.blocks[at]) && next?.kind === 'table' && !moving.has(`${sid}#${at + 1}`)) n = 2;
    grabbed.push({ m, blocks: s.blocks.splice(at, n) });
  }
  for (const { m, blocks } of grabbed.reverse()) {
    const t = sections.find((x) => x.id === m.to)!;
    const pos = m.position === 'start' ? 0 : m.position === 'after_first' ? Math.min(1, t.blocks.length) : t.blocks.length;
    t.blocks.splice(pos, 0, ...blocks);
  }
  // Seção que ficou vazia sai; se a página ficaria com menos de 3 seções, não move nada (seção vazia é inválida).
  const nonEmpty = sections.filter((s) => s.blocks.length > 0);
  if (nonEmpty.length < 3) return { draft: d, done: [] };
  return { draft: { ...d, sections: nonEmpty }, done: valid.map((m) => `${m.ref} → ${m.to}`) };
}

// Bloco de texto novo sem nenhuma fonte (basis evidence/reasoning e claim_ids vazio) sai em vez de derrubar o
// ajuste inteiro (22/10, guia de densidades: BASIS_REQUIRES_CLAIMS por um bloco que repetia o título da tabela).
export function dropClaimless(d: Draft, touched: Set<string>): { draft: Draft; dropped: string[] } {
  const dropped: string[] = [];
  const sections = d.sections.map((s) => ({
    ...s,
    blocks: s.blocks.filter((b, i) => {
      const bad = b.kind !== 'table' && b.basis !== 'framing' && b.claim_ids.length === 0 && touched.has(`${s.id}#${i}`);
      if (bad) dropped.push(`${s.id}#${i}`);
      return !bad;
    }),
  }));
  return { draft: { ...d, sections }, dropped };
}
