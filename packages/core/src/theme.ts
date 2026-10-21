import { z } from 'zod';

// Tema do site (data/theme.json): o que o editor pode mudar pelo chat do painel sem tocar em código.
// Cada valor tem faixa validada: um pedido nunca quebra o site (cor inválida, texto gigante, etc.).
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const Theme = z.object({
  colors: z.object({
    bg: Hex.default('#fbfaf7'), surface: Hex.default('#ffffff'), sand: Hex.default('#f4efe6'), ink: Hex.default('#15241f'),
    muted: Hex.default('#55635c'), line: Hex.default('#e7e2d8'), brand: Hex.default('#1e5b4c'), brand_ink: Hex.default('#123d33'),
    brand_soft: Hex.default('#e6f2ec'), amber: Hex.default('#f0b252'), amber_soft: Hex.default('#fdf3e1'),
  }).prefault({}),
  radius_px: z.number().int().min(0).max(28).default(16),
  text_scale: z.number().min(0.9).max(1.2).default(1),
  heading_scale: z.number().min(0.85).max(1.2).default(1),
  cta: z.object({ label: z.string().min(3).max(40).default('Ver preço na Amazon'), style: z.enum(['cheio', 'contorno']).default('cheio') }).prefault({}),
  examples_position: z.enum(['inicio', 'meio', 'fim']).default('meio'),
  texts: z.object({
    verdict_label: z.string().min(3).max(30).default('Resposta curta'),
    examples_title: z.string().min(3).max(40).default('Exemplos à venda'),
    related_title: z.string().min(3).max(40).default('Guias relacionados'),
    hero_button: z.string().min(3).max(30).default('Ver os guias'),
  }).prefault({}),
});
export type Theme = z.infer<typeof Theme>;

export const DEFAULT_THEME: Theme = Theme.parse({});
