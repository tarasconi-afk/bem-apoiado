import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Source, type SourceClass } from '@bem-apoiado/core';
import { EXTRACTOR_VERSION, htmlToText, pdfToText } from './extract.ts';
import { SOURCES_DIR, writeJson } from './store.ts';
import { webExtract } from './search.ts';

const UA = 'Mozilla/5.0 (compatible; BemApoiadoBot/0.1; +https://bemapoiado.com.br/sobre)';

export interface SnapshotInput {
  url: string;
  // 'direct' = baixa a página; 'tavily' = texto extraído pela Tavily (para sites que bloqueiam a VPS).
  via?: 'direct' | 'tavily';
  publisher: string;
  sourceClass: SourceClass;
  note?: string;
}

// Captura imutável: mesmo conteúdo na mesma URL gera o mesmo id; conteúdo novo gera snapshot novo.
export async function snapshot(input: SnapshotInput): Promise<{ source: Source; created: boolean }> {
  if (input.via === 'tavily') return snapshotViaTavily(input);
  const res = await fetch(input.url, {
    redirect: 'follow',
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${input.url}`);

  const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  const sha256 = createHash('sha256').update(body).digest('hex');
  const id = 'src_' + createHash('sha256').update(`${res.url}\n${sha256}`).digest('hex').slice(0, 12);
  const dir = join(SOURCES_DIR, id);
  if (existsSync(join(dir, 'meta.json'))) {
    const existing = Source.parse(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')));
    // Mesmo conteúdo já salvo e íntegro: nada a fazer. Bruto corrompido: regrava a partir do download.
    if (rawIntact(existing)) return { source: existing, created: false };
  }

  const isPdf = contentType === 'application/pdf' || input.url.toLowerCase().endsWith('.pdf');
  const extracted = await extractText(body, isPdf);
  if (extracted.text.length < 200) {
    throw new Error(`Texto extraído curto demais (${extracted.text.length}): página dinâmica ou bloqueio em ${input.url}`);
  }

  mkdirSync(dir, { recursive: true });
  const rawFile = isPdf ? 'raw.pdf' : 'raw.html';
  writeFileSync(join(dir, rawFile), body);
  writeFileSync(join(dir, 'text.txt'), extracted.text + '\n');

  const source = Source.parse({
    id,
    url: input.url,
    final_url: res.url,
    fetched_at: new Date().toISOString(),
    http_status: res.status,
    content_type: contentType,
    sha256,
    raw_file: rawFile,
    text_file: 'text.txt',
    text_chars: extracted.text.length,
    extractor_version: EXTRACTOR_VERSION,
    title: extracted.title,
    publisher: input.publisher,
    source_class: input.sourceClass,
    ...(input.note ? { note: input.note } : {}),
  });
  writeJson(join(dir, 'meta.json'), source);
  return { source, created: true };
}

export function rawIntact(source: Source): boolean {
  const p = join(SOURCES_DIR, source.id, source.raw_file);
  return existsSync(p) && createHash('sha256').update(readFileSync(p)).digest('hex') === source.sha256;
}

async function extractText(body: Uint8Array, isPdf: boolean) {
  return isPdf ? await pdfToText(body) : htmlToText(new TextDecoder('utf-8').decode(body));
}

// Regera text.txt a partir do bruto já salvo (sem baixar de novo) quando o extrator evolui.
// O sha256 do bruto não muda, então o id da fonte continua o mesmo.
export async function reextract(source: Source): Promise<Source> {
  const dir = join(SOURCES_DIR, source.id);
  const body = new Uint8Array(readFileSync(join(dir, source.raw_file)));
  if (source.raw_file === 'raw.txt') return source; // texto da Tavily: já é o texto final
  const extracted = await extractText(body, source.raw_file.endsWith('.pdf'));
  writeFileSync(join(dir, 'text.txt'), extracted.text + '\n');
  const updated = Source.parse({ ...source, text_chars: extracted.text.length, extractor_version: EXTRACTOR_VERSION });
  writeJson(join(dir, 'meta.json'), updated);
  return updated;
}

// O "bruto" guardado é o texto da Tavily (não o HTML original); a nota da fonte registra isso, e o
// hash continua garantindo que o que foi citado é exatamente o que foi capturado.
async function snapshotViaTavily(input: SnapshotInput): Promise<{ source: Source; created: boolean }> {
  const text = (await webExtract(input.url)).replace(/\r/g, '').trim();
  const body = new TextEncoder().encode(text);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const id = 'src_' + createHash('sha256').update(`${input.url}\n${sha256}`).digest('hex').slice(0, 12);
  const dir = join(SOURCES_DIR, id);
  if (existsSync(join(dir, 'meta.json'))) {
    const existing = Source.parse(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')));
    if (rawIntact(existing)) return { source: existing, created: false };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'raw.txt'), body);
  writeFileSync(join(dir, 'text.txt'), text + '\n');
  const source = Source.parse({
    id, url: input.url, final_url: input.url, fetched_at: new Date().toISOString(), http_status: 200,
    content_type: 'text/plain', sha256, raw_file: 'raw.txt', text_file: 'text.txt', text_chars: text.length,
    extractor_version: EXTRACTOR_VERSION, title: null, publisher: input.publisher, source_class: input.sourceClass,
    note: [input.note, 'capturado via Tavily extract (texto extraído, não o HTML original)'].filter(Boolean).join(' · '),
  });
  writeJson(join(dir, 'meta.json'), source);
  return { source, created: true };
}
