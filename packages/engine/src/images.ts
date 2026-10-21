import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';

// Imagens ilustrativas geradas por IA (gpt-image via AI Router). Uma por tipo de produto do nicho,
// mais a capa. Cada arquivo fica registrado com modelo, prompt, custo e hash: origem auditável.
// Nunca retratam marca, modelo ou produto específico; o site as marca como "gerada por IA".

export const Brief = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  kind: z.string().optional(),
  alt: z.string().min(10),
  prompt: z.string().min(40),
  size: z.enum(['1536x1024', '1024x1024', '1024x1536']).default('1536x1024'),
});
export type Brief = z.infer<typeof Brief>;

export const ImageRecord = z.object({
  id: z.string(),
  kind: z.string().optional(),
  file: z.string(),
  alt: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  model: z.string(),
  quality: z.string(),
  prompt: z.string(),
  credits: z.number(),
  sha256: z.string(),
  created_at: z.iso.datetime(),
  license: z.string(),
});
export type ImageRecord = z.infer<typeof ImageRecord>;

// Regras que valem para toda imagem, além do pedido específico.
const HOUSE_STYLE =
  ' Editorial interior/product photography, soft natural window light, warm neutral palette (cream, light oak, sage green accents), realistic materials, high detail. ' +
  'No people, no text, no letters, no numbers, no logos, no brand marks, no labels, no packaging.';

export function imagePaths(root: string) {
  return {
    briefs: join(root, 'data/images/briefs.json'),
    registry: join(root, 'data/images/registry.json'),
    outDir: join(root, 'site/src/assets/generated'),
  };
}

export function loadRegistry(root: string): ImageRecord[] {
  const f = imagePaths(root).registry;
  return existsSync(f) ? z.array(ImageRecord).parse(JSON.parse(readFileSync(f, 'utf8'))) : [];
}

export interface GenerateOptions {
  model?: string;
  quality?: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function generateImage(b: Brief, root: string, o: GenerateOptions = {}): Promise<ImageRecord> {
  const key = process.env.NEXOS_API_KEY;
  if (!key) throw new Error('NEXOS_API_KEY ausente');
  const base = (process.env.NEXOS_BASE_URL ?? 'https://router.hostinger.com/v1').replace(/\/$/, '');
  const model = o.model ?? 'gpt-image-2';
  const quality = o.quality ?? 'medium';
  const res = await (o.fetchImpl ?? fetch)(`${base}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: b.prompt + HOUSE_STYLE, size: b.size, quality, n: 1 }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`imagem ${b.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { data: { b64_json: string }[]; usage?: { credits_charged?: number } };
  const png = Buffer.from(d.data[0]!.b64_json, 'base64');
  // WebP de 1600 px como original versionado (~200 KB); o Astro gera os tamanhos responsivos.
  const sharp = createRequire(join(root, 'package.json'))('sharp');
  const img = sharp(png).resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 });
  const { data: webp, info } = await img.toBuffer({ resolveWithObject: true });
  const paths = imagePaths(root);
  mkdirSync(paths.outDir, { recursive: true });
  writeFileSync(join(paths.outDir, `${b.id}.webp`), webp);
  const rec = ImageRecord.parse({
    id: b.id, kind: b.kind, file: `site/src/assets/generated/${b.id}.webp`, alt: b.alt, width: info.width, height: info.height,
    model, quality, prompt: b.prompt, credits: d.usage?.credits_charged ?? 0,
    sha256: createHash('sha256').update(webp).digest('hex'), created_at: (o.now ?? new Date()).toISOString(),
    license: `Gerada por IA para o projeto (${model} via Hostinger AI Router). Ilustrativa; não retrata produto específico.`,
  });
  const reg = loadRegistry(root).filter((r) => r.id !== b.id);
  mkdirSync(join(root, 'data/images'), { recursive: true });
  writeFileSync(paths.registry, JSON.stringify([...reg, rec].sort((a, x) => a.id.localeCompare(x.id)), null, 2) + '\n');
  return rec;
}

// Gera as que faltam (ou as pedidas). Teto por execução: imagem é a chamada mais cara do motor.
export async function generateMissing(root: string, opts: GenerateOptions & { only?: string[]; force?: boolean; maxImages?: number } = {}) {
  const briefs = z.array(Brief).parse(JSON.parse(readFileSync(imagePaths(root).briefs, 'utf8')));
  const have = new Set(loadRegistry(root).map((r) => r.id));
  const todo = briefs.filter((b) => (opts.only ? opts.only.includes(b.id) : opts.force || !have.has(b.id))).slice(0, opts.maxImages ?? 10);
  const done: ImageRecord[] = [];
  for (const b of todo) done.push(await generateImage(b, root, opts));
  return done;
}
