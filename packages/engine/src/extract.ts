import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';

// Versão do algoritmo de extração. Mudou? Rodar `engine reextract` e depois `validate`.
export const EXTRACTOR_VERSION = 3;

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,tr,br,div,section,article,figcaption,caption';
const BOILERPLATE = 'script,style,noscript,svg,iframe,template,nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo]';
// Contêineres de conteúdo principal, do mais específico ao mais genérico (gov.br/Plone usa #content-core).
const MAIN = ['#content-core', 'article', 'main', '[role=main]', '#content', '#main-content', '.content'];

// v3: tabelas também saem "linearizadas" no fim do texto, uma célula por linha com o rótulo da linha e da
// coluna ("Tabela X: Peso (Kg) 61 a 70, Altura (m) 1,61 a 1,70: D26/28*"). Sem isso a célula vira uma
// palavra solta e nenhum trecho literal consegue dizer o que ela significa. Determinístico e reproduzível
// a partir do bruto; o texto anterior não muda (as citações já gravadas continuam valendo).
export function linearizeTables($: cheerio.CheerioAPI): string[] {
  const out: string[] = [];
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray().map((tr) => $(tr).children('th,td').toArray());
    if (rows.length < 2 || rows[0]!.length < 2) return;
    const caption = clean($(table).find('caption').first().text()) || clean($(table).prevAll('h1,h2,h3,h4').first().text()) || clean($(table).parent().find('h1,h2,h3,h4').first().text()) || 'Tabela';
    // Cabeçalho em diagonal ("Altura (m)" / "Peso (Kg)" na mesma célula): 1º rótulo = colunas, 2º = linhas.
    const corner = $(rows[0]![0]!).children('span,div,p').toArray().map((e) => clean($(e).text())).filter(Boolean);
    const colLabel = corner.length >= 2 ? corner[0]! : '';
    const rowLabel = corner.length >= 2 ? corner[1]! : clean($(rows[0]![0]!).text());
    const heads = rows[0]!.map((c) => clean($(c).text()));
    for (const row of rows.slice(1)) {
      const rowHead = clean($(row[0]!).text());
      row.slice(1).forEach((cell, i) => {
        const v = clean($(cell).text());
        const col = heads[i + 1];
        if (!v || !col) return;
        out.push(`${caption}: ${rowLabel ? `${rowLabel} ` : ''}${rowHead}, ${colLabel ? `${colLabel} ` : ''}${col}: ${v}`);
      });
    }
  });
  return out;
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  $(BOILERPLATE).remove();
  const tables = linearizeTables($);
  $(BLOCK).each((_, el) => {
    $(el).append('\n');
  });
  let text = '';
  for (const sel of MAIN) {
    const t = tidy($(sel).first().text());
    if (t.length >= 300) {
      text = t;
      break;
    }
  }
  if (!text) text = tidy($('body').text() || $.root().text());
  if (tables.length) text += `\n\nTabelas (cada célula com a sua linha e a sua coluna):\n${tables.join('\n')}`;
  return { title, text };
}

export async function pdfToText(data: Uint8Array): Promise<{ title: string | null; text: string }> {
  // pdf.js transfere (desanexa) o buffer recebido; sem a cópia, o bruto seria gravado com 0 bytes.
  const parser = new PDFParse({ data: data.slice() });
  try {
    const res = await parser.getText();
    return { title: null, text: tidy(res.text) };
  } finally {
    await parser.destroy();
  }
}

function tidy(t: string): string {
  return t
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}
