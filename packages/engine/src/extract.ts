import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,tr,br,div,section,article,figcaption,caption';

export function htmlToText(html: string): { title: string | null; text: string } {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe,template').remove();
  const title = $('title').first().text().trim() || null;
  // Quebra de linha em blocos para não colar palavras de elementos vizinhos.
  $(BLOCK).each((_, el) => {
    $(el).append('\n');
  });
  const text = $('body').text() || $.root().text();
  return { title, text: tidy(text) };
}

export async function pdfToText(data: Uint8Array): Promise<{ title: string | null; text: string }> {
  const parser = new PDFParse({ data });
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
