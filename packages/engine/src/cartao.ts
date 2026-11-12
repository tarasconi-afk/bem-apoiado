import type { ChangeItem } from './changes.ts';

// O QUE ENTRA NO SITE, uma linha por mudança (12/11/2026, editor: "não consegui entender o que estou aplicando").
// Até aqui o cartão de manutenção dizia "Site todo" e mandava links, botões de busca e modelos citados ESCONDIDOS no
// formulário: o editor aplicava sem ver nenhum deles, e o "~76,5 créditos" do resumo parecia o preço de aplicar.
// Agora cada item do ramo (changes.ts) vira UMA linha com UMA caixa (name="manter"), em linguagem de leigo.
// Funções puras: o painel injeta título das páginas, prévia e endereço das miniaturas (testável sem git).
// Mesmo arquivo no BA e no FC (paridade de painel).

export interface CartaoCtx {
  titleOf: (slug: string) => string;
  // Página no ar que mostra exemplos de um tipo de produto (onde um produto novo aparece).
  pageFor: (kind?: string) => string | undefined;
  // Link para a prévia do ramo (já com o rótulo), ou '' sem prévia.
  prev: (path: string, label: string) => string;
  // Miniatura de uma imagem do ramo e, para troca, da versão atual no main.
  imgUrl: (path: string) => string;
  imgMainUrl: (path: string) => string;
  // Página do próprio cartão: o texto dela é o resultado do cartão e entra sempre (caixa travada).
  ownSlug?: string;
  // A página já está no ar (no main)? Capa de página nova não "troca" nada.
  isLive?: (slug: string) => boolean;
}

const h = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const q = (s: string) => `<q>${h(s)}</q>`;
const pg = (t: string) => `<span class="pg">${h(t)}</span>`;
const lista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

const imgName = (path: string) => path.split('/').pop()!.replace(/\.webp$/, '');
const asinOfImage = (path: string) => /^produto-([a-z0-9]{10})$/.exec(imgName(path))?.[1]?.toUpperCase();
const coverSlug = (path: string) => /^pagina-(.+)$/.exec(imgName(path))?.[1];

// Página(s) que cada item muda: base do título do cartão e do "e mais K página(s)".
export function pagesOf(it: ChangeItem, items: ChangeItem[], ctx: Pick<CartaoCtx, 'pageFor'>): string[] {
  if (it.id.startsWith('page:')) return [it.id.slice('page:'.length)];
  if (it.id.startsWith('image:')) {
    const c = coverSlug(it.paths[0] ?? '');
    if (c) return [c];
    const asin = asinOfImage(it.paths[0] ?? '');
    const prod = asin ? items.find((i) => i.asin === asin) : undefined;
    const p = prod ? ctx.pageFor(prod.kind) : undefined;
    return p ? [p] : [];
  }
  if (it.id.startsWith('product:')) {
    const p = ctx.pageFor(it.kind);
    return p ? [p] : [];
  }
  if (it.per?.length) return it.per.map((x) => x.slug);
  return [];
}

// "Travesseiro de pena de ganso ou de fibra e mais 2 páginas: 4 mudanças". Página principal: a da capa, senão a que
// mais aparece. Sem página nenhuma (tema, cadastro): "Site todo: N mudanças".
export function cardSubject(items: ChangeItem[], ctx: Pick<CartaoCtx, 'pageFor' | 'titleOf'>): string {
  const n = plural(items.length, 'mudança', 'mudanças');
  const count = new Map<string, number>();
  for (const it of items) for (const s of new Set(pagesOf(it, items, ctx))) count.set(s, (count.get(s) ?? 0) + 1);
  if (!count.size) return `Site todo: ${n}`;
  const cover = items.map((i) => (i.id.startsWith('image:') ? coverSlug(i.paths[0] ?? '') : undefined)).find((s) => s && count.has(s));
  const main = cover ?? [...count].sort((a, b) => b[1] - a[1])[0]![0];
  const others = count.size - 1;
  return `${ctx.titleOf(main)}${others ? ` e mais ${plural(others, 'página', 'páginas')}` : ''}: ${n}`;
}

function diffsHtml(it: ChangeItem, max: number): string {
  if (!it.diffs?.length) return '';
  return `<details><summary class="muted">antes → depois (${it.diffs.length})</summary>${it.diffs.slice(0, max).map((d) => `<div class="diff"><span class="muted">${h(d.where)}</span><del>${h(d.before)}</del><ins>${h(d.after)}</ins></div>`).join('')}</details>`;
}

// Uma linha: rótulo curto do tipo + frase de leigo + (às vezes) explicação menor e miniaturas.
export function itemLine(it: ChangeItem, items: ChangeItem[], ctx: CartaoCtx): { tag: string; html: string } {
  const sub = (s: string) => `<span class="sub">${h(s)}</span>`;
  if (it.id.startsWith('page:')) {
    const s = it.id.slice('page:'.length);
    const nova = /^Página nova no ar/.test(it.title);
    const sai = /sai do ar|volta a rascunho/.test(it.title);
    const head = nova ? `Página nova no ar: ${pg(ctx.titleOf(s))}` : sai ? h(it.title) : `Texto de ${pg(ctx.titleOf(s))}: ${plural(it.diffs?.length ?? 0, 'trecho alterado', 'trechos alterados')}`;
    const p = ctx.prev(`${h(s)}/`, 'ver na prévia');
    return { tag: 'Texto', html: `${head}${p ? ` ${p}` : ''}${s === ctx.ownSlug ? '' : diffsHtml(it, 30)}` };
  }
  if (it.id.startsWith('image:')) {
    const path = it.paths[0] ?? '';
    const c = coverSlug(path);
    const asin = asinOfImage(path);
    const prod = asin ? items.find((i) => i.asin === asin) : undefined;
    const fig = (src: string, cap: string, alt: string) => `<figure><img loading="lazy" src="${h(src)}" alt="${h(alt)}"><figcaption>${h(cap)}</figcaption></figure>`;
    const nova = fig(ctx.imgUrl(path), it.replaces ? 'nova (IA)' : 'nova (IA)', 'imagem nova gerada por IA');
    const swap = it.replaces ? `<div class="swap">${fig(ctx.imgMainUrl(path), 'hoje', 'imagem atual')}<span class="arr" aria-hidden="true">→</span>${nova}</div>` : `<div class="swap">${nova}</div>`;
    if (c) {
      const head = it.replaces
        ? `Capa de ${pg(ctx.titleOf(c))} trocada por uma nova`
        : ctx.isLive && !ctx.isLive(c)
          ? `Capa da página nova ${pg(ctx.titleOf(c))}`
          : `Capa de ${pg(ctx.titleOf(c))} trocada: da ilustração genérica para uma capa própria`;
      return { tag: 'Imagem', html: `${head}${swap}` };
    }
    if (asin) {
      const label = prod?.title.replace(/^Novo exemplo à venda: /, '') ?? asin;
      return { tag: 'Imagem', html: `Foto do exemplo à venda ${h(label)}${it.replaces ? ' trocada' : ''}${swap}` };
    }
    return { tag: 'Imagem', html: `Ilustração do tipo ${h(imgName(path).replace(/_/g, ' '))}${it.replaces ? ' trocada' : ' nova'}${swap}` };
  }
  if (it.id.startsWith('product:')) {
    const anuncio = it.asin ? ` <a href="https://www.amazon.com.br/dp/${h(it.asin)}" target="_blank" rel="noopener">anúncio</a>` : '';
    if (it.title.startsWith('Novo exemplo')) {
      const where = ctx.pageFor(it.kind);
      const label = it.title.replace(/^Novo exemplo à venda: /, '');
      const how = /só anúncio/.test(it.detail ?? '') ? 'Só anúncio, sem ficha do fabricante.' : /editor/.test(it.detail ?? '') ? 'Escolhido por você.' : 'Com ficha do fabricante.';
      const p = where ? ctx.prev(`${h(where)}/#exemplos`, 'ver na prévia') : '';
      return { tag: 'Produto', html: `Exemplo à venda novo${where ? ` em ${pg(ctx.titleOf(where))}` : ''}: ${h(label)}${anuncio}${p ? ` · ${p}` : ''}${sub(how)}` };
    }
    return { tag: 'Produto', html: `${h(it.title)}${anuncio}${it.detail ? sub(it.detail) : ''}` };
  }
  if (it.id === 'search-links') {
    const frases = (it.per ?? []).map((x) => {
      const p = ctx.prev(`${h(x.slug)}/`, 'ver na prévia');
      const botoes = x.values.map(q).join(', ');
      return x.had ? `${pg(ctx.titleOf(x.slug))}: os botões "buscar na Amazon" passam a ser ${botoes}${p ? ` ${p}` : ''}` : `${pg(ctx.titleOf(x.slug))} ganha ${plural(x.values.length, 'botão', 'botões')} "buscar na Amazon": ${botoes}${p ? ` ${p}` : ''}`;
    });
    return { tag: 'Botões', html: `${frases.join('<br>') || h(it.title)}${sub('Links com a nossa tag, embaixo dos exemplos à venda.')}` };
  }
  if (it.id === 'cited') {
    const frases = (it.per ?? []).map((x) => `${pg(ctx.titleOf(x.slug))}: os modelos citados no texto viram link "Ver na Amazon": ${h(x.values.join(', '))}`);
    return { tag: 'Links', html: `${frases.join('<br>') || h(it.title)}${sub('O texto não muda; só os nomes ficam clicáveis.')}` };
  }
  if (it.id === 'anchors') {
    const frases = (it.per ?? []).map((x) => `Em outras páginas, ${lista(x.values.map(q))} ${x.values.length === 1 ? 'passa' : 'passam'} a levar para ${pg(ctx.titleOf(x.slug))}`);
    return { tag: 'Links internos', html: `${frases.join('<br>') || h(it.title)}${sub('O texto das outras páginas não muda.')}` };
  }
  if (it.id === 'theme') return { tag: 'Visual', html: `${h(it.title)}${it.detail ? sub(it.detail) : ''}` };
  if (it.id === 'home') return { tag: 'Home', html: `${h(it.title)}${it.detail ? sub(it.detail) : ''}` };
  if (it.id === 'niche') return { tag: 'Cadastro', html: h(it.title) };
  return { tag: 'Outro', html: `${h(it.title)}${it.detail ? sub(it.detail) : ''}` };
}

// O bloco recolhível. A linha da própria página do cartão (página nova / ajuste) entra sempre: é o resultado do
// cartão; para não publicar, o editor usa "Descartar". As demais têm caixa marcada que o editor pode desmarcar.
export function whatBlock(items: ChangeItem[], ctx: CartaoCtx, open = true): string {
  if (!items.length) return '';
  const own = (it: ChangeItem) => !!ctx.ownSlug && it.id === `page:${ctx.ownSlug}`;
  const lines = items.map((it) => {
    const { tag, html } = itemLine(it, items, ctx);
    const box = own(it)
      ? `<input type="hidden" name="manter" value="${h(it.id)}"><span class="lock" title="é o resultado deste cartão; para não publicar, use Descartar">✓</span>`
      : `<input type="checkbox" name="manter" value="${h(it.id)}" checked aria-label="aceitar esta mudança">`;
    return `<li>${box}<div class="ln"><span class="k">${h(tag)}</span>${html}</div></li>`;
  });
  const optional = items.filter((it) => !own(it)).length;
  return `<details class="what"${open ? ' open' : ''}><summary>O que entra no site (${items.length})${optional ? ' <span class="muted">· desmarque o que não quiser</span>' : ''}</summary><ul class="ch">${lines.join('')}</ul></details>`;
}

const fmtCred = (x: number) => x.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Onde os créditos do ciclo foram (quase sempre na pauta tentada) e que aplicar é de graça.
export function costLine(cost: number | null, query: string | undefined, outcome: string | null, kind: string): string {
  if (cost === null) return '';
  const o = outcome?.startsWith('virou rascunho') ? 'virou rascunho' : outcome?.startsWith('virou página') ? 'virou página' : outcome?.startsWith('não virou página') ? 'não virou página' : '';
  const where = query ? `, quase tudo na pauta ${kind === 'manutencao' ? 'nova ' : ''}"${h(query)}"${o && kind === 'manutencao' ? ` (${o})` : ''}` : '';
  const verb = kind === 'pagina-nova' ? 'Publicar' : 'Aplicar';
  return `<div class="cost"><b>Custo:</b> o ciclo gastou ~${fmtCred(cost)} créditos${where}. <b>${verb} não gasta créditos.</b></div>`;
}

// No resumo do cartão: "ciclo custou ~X", para não parecer o preço de aplicar.
export const costSummary = (cost: number | null) => (cost === null ? '' : ` · ciclo custou ~${fmtCred(cost)} créditos`);

export function learningLine(learning: string[]): string {
  return learning.length ? `<div class="learn"><b>Não muda o site, entra junto:</b> ${h(learning.join(' · '))}.</div>` : '';
}

// Cartão de manutenção que só troca capa/produto de uma página no ar: o editor procurava "Pedir correção" nele
// (12/11, travesseiro de pena de ganso) e o texto se corrige pela aba Páginas.
export function textHint(items: ChangeItem[], coverTitle: string | undefined, onde: string): string {
  if (!coverTitle || items.some((i) => i.id.startsWith('page:'))) return '';
  return `<div class="hint"><b>Esta mudança não mexe no texto de ${h(coverTitle)}.</b> Para pedir correção no texto: ${h(onde)}.</div>`;
}

export const CARTAO_CSS = `
.dbody .cost{font-size:.85rem;background:var(--nbg);border-radius:8px;padding:8px 12px;margin:8px 0}.dbody .cost b{font-weight:600}
details.what{border:1px solid var(--line);border-radius:10px;margin:8px 0;background:var(--card)}
details.what>summary{cursor:pointer;padding:10px 12px;font-weight:600}
details.what>summary .muted{font-weight:400;font-size:.85rem}
ul.ch{list-style:none;margin:0;padding:0 12px 6px}
ul.ch li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;padding:9px 0;border-top:1px solid var(--line)}
ul.ch li:first-child{border-top:0}ul.ch input[type=checkbox]{margin-top:4px;accent-color:var(--accent)}
ul.ch .lock{color:var(--ok);font-weight:700}
ul.ch .ln{min-width:0}ul.ch .ln .k{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);background:var(--nbg);border-radius:4px;padding:1px 6px;margin-right:6px;vertical-align:1px}
ul.ch .ln .pg{font-weight:600}ul.ch .ln .sub{display:block;font-size:.85rem;color:var(--muted);margin-top:2px}
ul.ch .ln q{quotes:"“" "”"}
ul.ch .swap{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
ul.ch .swap figure{margin:0;display:grid;gap:2px;font-size:.72rem;color:var(--muted);text-align:center}
ul.ch .swap img{width:120px;max-width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
ul.ch .swap .arr{color:var(--muted)}
.dbody .learn{font-size:.85rem;color:var(--muted);border-left:3px solid var(--line);padding:2px 0 2px 10px;margin:8px 0}.dbody .learn b{color:var(--ink);font-weight:600}
.dbody .hint{font-size:.85rem;background:var(--warnbg);color:var(--warn);border-radius:8px;padding:8px 12px;margin:8px 0}
`;
