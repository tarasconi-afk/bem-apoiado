import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Source, type SourceClass } from '@bem-apoiado/core';
import { htmlToText, pdfToText } from './extract.ts';
import { SOURCES_DIR, writeJson } from './store.ts';

const UA = 'Mozilla/5.0 (compatible; BemApoiadoBot/0.1; +https://bemapoiado.com.br/sobre)';

export interface SnapshotInput {
  url: string;
  publisher: string;
  sourceClass: SourceClass;
  note?: string;
}

// Captura imutável: mesmo conteúdo na mesma URL gera o mesmo id; conteúdo novo gera snapshot novo.
export async function snapshot(input: SnapshotInput): Promise<{ source: Source; created: boolean }> {
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
    return { source: Source.parse(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))), created: false };
  }

  const isPdf = contentType === 'application/pdf' || input.url.toLowerCase().endsWith('.pdf');
  const extracted = isPdf ? await pdfToText(body) : htmlToText(new TextDecoder('utf-8').decode(body));
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
    title: extracted.title,
    publisher: input.publisher,
    source_class: input.sourceClass,
    ...(input.note ? { note: input.note } : {}),
  });
  writeJson(join(dir, 'meta.json'), source);
  return { source, created: true };
}
