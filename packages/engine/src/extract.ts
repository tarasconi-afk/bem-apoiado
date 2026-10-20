import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';

// Versão do algoritmo de extração. Mudou? Rodar `engine reextract` e depois `validate`.
export const EXTRACTOR_VERSION = 2;

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,tr,br,div,section,article,figcaption,caption';
const BOILERPLATE = 'script,style,noscript,svg,iframe,template,nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo]';
// Contêineres de conteúdo principal, do mais específico ao mais genérico (gov.br/Plone usa #content-core).
const MAIN = ['#content-core', 'article', 'main', '[role=main]', '#content', '#main-content', '.content'];

export function htmlToText(html: string): { title: string | null; text: string } {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  $(BOILERPLATE).remove();
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
