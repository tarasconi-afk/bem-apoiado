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

// Atribuição por código, antes do auditor (22/10: na cadeira para obeso, 8 de 11 recusas que se repetiam nas
// 3 auditorias eram "regra geral" tirada de um fabricante só, sem dizer de quem; o redator errava de novo a cada
// rodada). Bloco cujas evidências são todas de UM fabricante e que não cita o nome dele ganha ", segundo a X" no
// fim da 1ª frase; tabela com fonte única leva o nome no título. Não muda fato nem fonte.
export function attributeSingleSource(d: Draft, sourceOf: (claimId: string) => { publisher: string; source_class: string } | undefined): { draft: Draft; refs: string[] } {
  const refs: string[] = [];
  const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Fabricantes do bloco. Até 29/10, bastava UMA fonte não-fabricante para a atribuição desistir do bloco
  // inteiro ("com norma ou regulador junto, a regra geral pode estar certa"). Na toalha de banho isso derrubou
  // a página: o bloco citava Inmetro e fabricantes, e o auditor foi exato — "os trechos do Inmetro sustentam
  // composição, dimensão e conservação, NÃO a recomendação de tamanho", que é dos fabricantes. Agora o bloco
  // misto é atribuível, mas só nas frases que não falam do regulador (ver `doRegulador`).
  const single = (ids: string[]) => {
    const srcs = ids.map(sourceOf).filter((s): s is NonNullable<typeof s> => !!s);
    const fab = [...new Set(srcs.filter((s) => s.source_class === 'manufacturer').map((s) => s.publisher))];
    return fab.length ? fab : null;
  };
  // Todos os publishers do bloco, inclusive regulador: frase que já nomeia qualquer um deles não é órfã.
  const todos = (ids: string[]) => [...new Set(ids.map(sourceOf).filter((s): s is NonNullable<typeof s> => !!s).map((s) => s.publisher))];
  // Frase de norma: mesmo sem nomear o órgão, ela não é afirmação de fabricante e não pode receber "segundo a
  // Appel". É o guarda-corpo que permite atribuir em bloco misto sem trocar a fonte de lugar.
  const doRegulador = (frase: string) => /\b(exige|obrigat|norma|portaria|regulament|resolu[çc][ãa]o|NBR|ISO|NM ISO)\b/i.test(frase);
  // 3 ou mais fabricantes dizendo o mesmo: "fabricantes como X, Y e Z" (22/10, casal com pesos diferentes: 4 marcas
  // na resposta curta e nenhuma nomeada).
  const who = (pubs: string[]) => (pubs.length <= 2 ? pubs.map((p) => `a ${p}`).join(' e ') : `fabricantes como ${pubs.slice(0, 2).join(', ')} e ${pubs[2]}`);
  // Uma frase já diz de quem é o dado? Nome do fabricante nela, ou "segundo/conforme/de acordo com" + nome próprio.
  const atribuida = (frase: string, pubs: string[]) => pubs.some((p) => norm(frase).includes(norm(p))) || /\b(segundo|conforme|de acordo com)\s+(a|o|os|as)\s+\p{Lu}/u.test(frase);
  // A segunda atribuição do mesmo bloco usa "conforme": com "segundo" nas duas o parágrafo vira ladainha.
  const comFonte = (frase: string, pubs: string[], conector = 'segundo') => {
    const m = /^([\s\S]*?)([.!?])(\s*)$/.exec(frase);
    return m ? `${m[1]}, ${conector} ${who(pubs)}${m[2]}${m[3]}` : `${frase.replace(/[.\s]*$/, '')}, ${conector} ${who(pubs)}.`;
  };
  // Duas atribuições por bloco bastam: os blocos têm no máximo 70 palavras, e repetir "segundo a X" em toda
  // frase deixa o texto pesado — o editor já reclamou de naturalidade em 28/10.
  const MAX_ATRIBUICOES = 2;
  // Frase que NÃO precisa de fonte, mesmo trazendo número. Sem este filtro a segunda atribuição caía em
  // orientação ao leitor e em exemplo, e o texto virava "…, segundo a Karsten e a Trussardi. … , segundo a
  // Karsten e a Trussardi." — medido em 65% dos blocos tocados, inclusive de páginas que já passavam.
  const INSTRUCAO = /^\s*(confira|procure|verifique|me[çc]a|compare|escolha|prefira|consulte|observe|use|leve|some|anote)\b/i;
  const EXEMPLO = /^\s*(exemplos?\b|por exemplo\b|ex\.:)/i;
  // Já diz que quem informa é o fabricante/a ficha: a frase não se apresenta como fato do mercado.
  const JA_E_DECLARACAO = /\b(o|os|a|as)\s+fabricantes?\b|\b(a ficha|a etiqueta|o an[úu]ncio|o r[óo]tulo)\b/i;
  const precisaDeFonte = (f: string) => !INSTRUCAO.test(f) && !EXEMPLO.test(f) && !JA_E_DECLARACAO.test(f) && !doRegulador(f);
  // `nomes` = todos os publishers do bloco (inclui regulador): frase que já nomeia qualquer um deles fica quieta.
  const attribute = (text: string, pubs: string[], nomes: string[] = pubs) => {
    // Atribuição genérica já escrita ("segundo os fabricantes citados") vira a com nomes, sem duplicar (23/10:
    // "segundo os fabricantes citados, segundo fabricantes como Castor, Ortobom e Probel").
    const generic = /(segundo|conforme|de acordo com) (os |as )?(fabricantes|marcas|fontes)( citad[oa]s)?/i;
    const base = generic.test(text)
      ? text.replace(generic, (m0) => `${m0.split(' ')[0]!.toLowerCase() === 'segundo' ? 'segundo' : m0.split(' ')[0]!} ${who(pubs)}`.replace(/^(\w)/, (c) => (m0[0] === m0[0]!.toUpperCase() ? c.toUpperCase() : c)))
      : text;
    // Frase a frase, e não só a primeira. Até 29/10 bastava o nome do fabricante aparecer uma vez no bloco para
    // o resto passar sem atribuição — e o auditor recusava com essa frase exata (27/10, colchão firme ou macio:
    // "os trechos citados são todos da Castor, mas o bloco apresenta como fatos gerais as faixas de densidade
    // por peso; apenas a definição inicial é explicitamente atribuída"). MISATTRIBUTED na decisão e na resposta
    // curta foi a maior causa isolada de não convergência da semana.
    const frases = base.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [base];
    let postas = 0;
    const saida = frases.map((f, i) => {
      if (postas >= MAX_ATRIBUICOES || atribuida(f, nomes)) return f;
      // A primeira frase sempre; as seguintes só quando trazem número declarado (faixa, medida, densidade), que
      // é o que o auditor lê como regra geral de fabricante apresentada como fato do mercado.
      if (doRegulador(f)) return f;
      if (i !== 0 && (!/\d/.test(f) || !precisaDeFonte(f))) return f;
      postas++;
      return comFonte(f, pubs, postas === 1 ? 'segundo' : 'conforme');
    });
    return postas ? saida.join('') : base;
  };
  const out: Draft = structuredClone(d);
  const pv = single(out.verdict.claim_ids);
  if (pv && out.verdict.basis !== 'framing') {
    const t = attribute(out.verdict.text, pv, todos(out.verdict.claim_ids));
    if (t !== out.verdict.text) { out.verdict = { ...out.verdict, text: t }; refs.push('verdict'); }
  }
  for (const s of out.sections) s.blocks.forEach((b, i) => {
    if (b.kind === 'table') {
      // Só fonte ÚNICA vai para o título: com 2 marcas o auditor julga cada linha e recusa "segundo a X e a Y" em
      // linha que é de uma só (22/10, solteirão ou viúva: 5 linhas recusadas por isso).
      const ps = single([...new Set(b.rows.flatMap((r) => r.cells.flatMap((c) => c.claim_ids)))]);
      const p = ps && ps.length === 1 ? ps : null;
      if (p && !p.some((x) => norm(b.caption).includes(norm(x)))) { b.caption = `${b.caption} (segundo ${who(p)})`; refs.push(`${s.id}#${i}`); }
      return;
    }
    if (b.basis === 'framing') return;
    const p = single(b.claim_ids);
    if (!p) return;
    const t = attribute(b.text, p, todos(b.claim_ids));
    if (t !== b.text) { b.text = t; refs.push(`${s.id}#${i}`); }
  });
  return { draft: out, refs };
}

// Remover bloco ou tabela por pedido do editor (23/10: "tire os blocos de garantia e o que vem incluso" no solteirão
// era ignorado; o ajuste só sabia reescrever, mover e trocar título). Sem IA e sem auditoria, porque tirar não afirma
// nada. Seção que fica vazia sai, mas nunca a última ("Como decidir"), e a página nunca fica com menos de 3 seções:
// nesse caso a remoção daquela seção não é feita e o motivo volta na resposta.
export function applyRemovals(d: Draft, refs: string[]): { draft: Draft; done: string[]; refused: string[] } {
  const sections = d.sections.map((x) => ({ ...x, blocks: [...x.blocks] }));
  const done: string[] = [];
  const refused: string[] = [];
  const valid = [...new Set(refs)].filter((r) => {
    const [sid, i] = r.split('#');
    return sections.find((x) => x.id === sid)?.blocks[Number(i)] !== undefined;
  });
  for (const r of valid.sort((a, b) => Number(b.split('#')[1]) - Number(a.split('#')[1]))) {
    const [sid, i] = r.split('#');
    const sec = sections.find((x) => x.id === sid)!;
    const last = sections.at(-1)!.id === sid;
    const nonEmpty = sections.filter((x) => x.blocks.length > 0).length;
    if (sec.blocks.length === 1 && (last || nonEmpty <= 3)) { refused.push(`${r} (a seção "${sec.heading}" ficaria vazia ${last ? 'e ela é a do "Como decidir"' : 'e a página teria menos de 3 seções'})`); continue; }
    sec.blocks.splice(Number(i), 1);
    done.push(r);
  }
  return { draft: { ...d, sections: sections.filter((x) => x.blocks.length > 0) }, done, refused };
}

// Tirar uma coluna de tabela por pedido do editor (24/10: "tire a coluna 'Para quem serve'" no solteirão não era
// possível; o ajuste só mexia na tabela inteira). Sem IA: a tabela continua com as outras colunas e as mesmas fontes.
// Tabela precisa de 2 colunas no mínimo; a 1ª (o rótulo da linha) nunca sai.
export function dropTableColumns(d: Draft, drops: { ref: string; column: string }[]): { draft: Draft; done: string[]; refused: string[] } {
  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const sections = d.sections.map((x) => ({ ...x, blocks: [...x.blocks] }));
  const done: string[] = [];
  const refused: string[] = [];
  for (const { ref, column } of drops) {
    const [sid, i] = ref.split('#');
    const sec = sections.find((x) => x.id === sid);
    const b = sec?.blocks[Number(i)];
    if (!sec || !b || b.kind !== 'table') { refused.push(`${ref} (não é tabela)`); continue; }
    const ci = b.columns.findIndex((c) => fold(c) === fold(column) || fold(c).includes(fold(column)));
    if (ci < 1) { refused.push(`coluna "${column}" (${ci === 0 ? 'é a coluna dos rótulos' : 'não existe nessa tabela'})`); continue; }
    if (b.columns.length <= 2) { refused.push(`coluna "${column}" (a tabela ficaria com uma coluna só)`); continue; }
    sec.blocks[Number(i)] = { ...b, columns: b.columns.filter((_, k) => k !== ci), rows: b.rows.map((r) => ({ ...r, cells: r.cells.filter((_, k) => k !== ci) })) };
    done.push(`coluna "${b.columns[ci]}" de ${ref}`);
  }
  return { draft: { ...d, sections }, done, refused };
}
