import { describe, expect, it } from 'vitest';
import { htmlToText, pdfToText } from '../src/extract.ts';

// PDF mínimo com uma linha de texto, montado à mão para o teste.
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => (out += `${String(off).padStart(10, '0')} 00000 n \n`));
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('pdfToText', () => {
  it('extrai o texto e não consome o buffer original', async () => {
    const pdf = tinyPdf('Densidade D33 conforme etiqueta');
    const before = pdf.byteLength;
    const r = await pdfToText(pdf);
    expect(r.text).toContain('Densidade D33 conforme etiqueta');
    expect(pdf.byteLength).toBe(before);
  });
});

describe('htmlToText', () => {
  it('prefere o conteúdo principal e descarta menu e rodapé', () => {
    const body = 'Conteúdo real sobre colchões e densidade da espuma. '.repeat(10);
    const html = `<html><head><title>T</title></head><body><nav>Menu Início Busca</nav>
      <div id="content-core"><p>${body}</p></div><footer>Rodapé do portal</footer></body></html>`;
    const r = htmlToText(html);
    expect(r.title).toBe('T');
    expect(r.text).toContain('Conteúdo real sobre colchões');
    expect(r.text).not.toContain('Menu Início');
    expect(r.text).not.toContain('Rodapé');
  });
});

import { htmlToText as h2t } from '../src/extract.ts';
describe('tabelas linearizadas (v3)', () => {
  it('cada célula sai com rótulo da linha e da coluna, inclusive cabeçalho em diagonal', () => {
    const html = `<html><body><main><p>${'texto '.repeat(80)}</p></main><div><h2>Tabela de colchões</h2><table>
      <tr><th><span>Altura (m)</span><hr/><span>Peso (Kg)</span></th><th>até 1,50</th><th>1,51 a 1,60</th></tr>
      <tr><th>até 50</th><td>D23</td><td></td></tr><tr><th>51 a 60</th><td>D26</td><td>D26*/23</td></tr></table></div></body></html>`;
    const t = h2t(html).text;
    expect(t).toContain('Tabela de colchões: Peso (Kg) até 50, Altura (m) até 1,50: D23');
    expect(t).toContain('Tabela de colchões: Peso (Kg) 51 a 60, Altura (m) 1,51 a 1,60: D26*/23');
    expect(t).not.toContain('Peso (Kg) até 50, Altura (m) 1,51 a 1,60');
  });
});
