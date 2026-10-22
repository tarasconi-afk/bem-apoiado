import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { addSpend } from './llm.ts';

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
  // Conta no teto do ciclo e no livro-caixa (antes só ia para o livro-caixa e o ciclo subestimava o gasto).
  addSpend(rec.credits, 'imagem', model);
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

// Piloto automático: o que ainda não tem imagem. Cada tipo de produto do nicho precisa da sua (vale para
// nicho novo) e cada página aprovada ganha uma capa própria ("pagina-<slug>"), para a home nunca repetir
// imagem. O pedido é escrito pelo modelo barato a partir do tipo ou do título e fica em briefs.json.
export interface Wanted {
  id: string;
  kind?: string;
  subject: string;
}

// Padrão da ilustração de anúncio (aprovado pelo editor em 22/10 nas 5 cadeiras): UM produto genérico do tipo,
// com a cor e o material que o anúncio descreve, num cômodo e num ângulo próprios, sem marca nem modelo
// reconhecível. A luz e a paleta da casa (HOUSE_STYLE) entram depois, iguais para todas.
// Cômodo por família de produto (22/10: colchão ao lado de mesa de escritório e travesseiro no chão da sala
// destoavam): o que é de dormir fica no quarto, o que é de trabalho fica no home office.
export const OFFICE_KINDS = ['cadeira', 'mesa', 'suporte_notebook'];
export const PRODUCT_SCENES: Record<'sleep' | 'office', string[]> = {
  office: [
    'calm home office corner beside a light oak desk',
    'bright minimalist home office with a light rug and a tall window',
    'cozy study with wooden shelves and a desk lamp',
    'white desk by a large window with green plants',
    'compact home office corner with a light grey wall and a small bookshelf',
    'quiet work nook with a sage-green wall and a floor lamp',
  ],
  sleep: [
    'airy bedroom with linen curtains and a wooden nightstand',
    'bright bedroom with a tall window and green plants by the wall',
    'calm bedroom with a sage-green wall and a woven rug',
    'cozy bedroom with a light oak headboard area and a reading lamp',
    'minimalist bedroom with white walls and a ceramic vase on the nightstand',
    'warm bedroom corner with a wooden bench and a folded throw',
  ],
};
export const sceneFamily = (kind: string): 'sleep' | 'office' => (OFFICE_KINDS.includes(kind) ? 'office' : 'sleep');
export const PRODUCT_VIEWS = ['three-quarter view', 'side view', 'front three-quarter view', 'rear three-quarter view'];
export function productSubject(kindLabel: string, label: string, brand: string, scene: string, view: string): string {
  const desc = label.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/\s+/g, ' ').trim();
  return (
    `ilustração de anúncio: UM único ${kindLabel} genérico com o formato, a cor e o material descritos em "${desc}" ` +
    `(ignore nomes de modelo e de marca). Cena: ${scene}. Enquadramento: ${view}, o produto inteiro e em destaque, no lugar onde é usado ` +
    `(colchão e base de cama montados no quarto; travesseiro sobre a cama arrumada; cadeira junto à mesa). ` +
    `Termine o prompt com "Generic design, no recognizable model." O alt começa com "Ilustração: " e descreve tipo, cor e material.`
  );
}

// Cada anúncio do catálogo também ganha a sua (22/10: o editor achou repetitivo o mesmo desenho do tipo em
// todos os cartões). Mostra o tipo com o formato, a cor e o material que o anúncio descreve, sem a marca
// (que sai do texto do pedido) e sem copiar o modelo.
export function wantedImages(
  root: string,
  kinds: { id: string; label: string }[],
  pages: { slug: string; title: string; status: string }[],
  products: { asin: string; kind: string; brand: string; label: string }[] = [],
): Wanted[] {
  const have = new Set(loadRegistry(root).map((r) => r.id));
  const out: Wanted[] = [];
  for (const k of kinds) if (!have.has(k.id)) out.push({ id: k.id, kind: k.id, subject: `tipo de produto: ${k.label}. Mostrar como esse tipo é construído ou o que o distingue visualmente dos outros tipos.` });
  for (const p of pages) if (p.status !== 'draft' && !have.has(`pagina-${p.slug}`)) out.push({ id: `pagina-${p.slug}`, subject: `capa de um guia intitulado "${p.title}". Cena que ilustre o tema do guia, sem mostrar produto de marca.` });
  const kindLabel = new Map(kinds.map((k) => [k.id, k.label]));
  for (const p of products) {
    if (have.has(`produto-${p.asin.toLowerCase()}`)) continue;
    // Cena e ângulo em rodízio dentro do mesmo tipo: dois anúncios de cadeira nunca caem no mesmo cômodo.
    const sameKind = products.filter((x) => x.kind === p.kind).map((x) => x.asin).sort();
    const i = sameKind.indexOf(p.asin) + [...p.kind].reduce((t, c) => t + c.charCodeAt(0), 0);
    out.push({ id: `produto-${p.asin.toLowerCase()}`, subject: productSubject(kindLabel.get(p.kind) ?? p.kind, p.label, p.brand, PRODUCT_SCENES[sceneFamily(p.kind)][i % PRODUCT_SCENES[sceneFamily(p.kind)].length]!, PRODUCT_VIEWS[i % PRODUCT_VIEWS.length]!) });
  }
  return out;
}

const BriefOut = z.object({ alt: z.string().min(10).max(160), prompt: z.string().min(60).max(900) });

export async function ensureImages(
  root: string,
  kinds: { id: string; label: string }[],
  pages: { slug: string; title: string; status: string }[],
  writeBrief: (subject: string) => Promise<{ alt: string; prompt: string }>,
  opts: GenerateOptions & { max?: number; products?: { asin: string; kind: string; brand: string; label: string }[] } = {},
): Promise<ImageRecord[]> {
  const todo = wantedImages(root, kinds, pages, opts.products).slice(0, opts.max ?? 2);
  const briefsFile = imagePaths(root).briefs;
  const done: ImageRecord[] = [];
  for (const w of todo) {
    const briefs = existsSync(briefsFile) ? z.array(Brief).parse(JSON.parse(readFileSync(briefsFile, 'utf8'))) : [];
    // Pedido já escrito (pelo editor ou pelo desenvolvedor) vale; só o que falta é escrito pelo modelo.
    const ready = briefs.find((x) => x.id === w.id);
    const b = ready ?? Brief.parse({ id: w.id, kind: w.kind, ...(await writeBrief(w.subject)) });
    writeFileSync(briefsFile, JSON.stringify([...briefs.filter((x) => x.id !== b.id), b], null, 2) + '\n');
    done.push(await generateImage(b, root, opts));
  }
  return done;
}

export const BRIEF_SYSTEM =
  'Você escreve pedidos para um gerador de imagens de um site editorial brasileiro. Devolva "prompt" em inglês ' +
  '(uma cena fotográfica realista, concreta, com materiais e enquadramento) e "alt" em português (descrição curta ' +
  'do que a imagem mostra). Proibido: pessoas, texto, números, logotipos, marcas, embalagens, produto identificável. ' +
  'O estilo de luz e paleta é acrescentado depois; não repita. Exemplo aprovado de ilustração de anúncio: ' +
  '"A single generic high-back racing-style gaming chair in warm brown upholstery with contrasting stitching, head and lumbar ' +
  'cushions, padded armrests, in a cozy study with wooden shelves and a desk lamp. Front three-quarter view. Generic design, no recognizable model."';
export { BriefOut };
