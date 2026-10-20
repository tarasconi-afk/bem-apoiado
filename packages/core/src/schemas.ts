import { z } from 'zod';

// Identificadores estáveis. O LLM só pode referenciar estes ids, nunca índices.
export const SourceId = z.string().regex(/^src_[a-f0-9]{12}$/);
export const ClaimId = z.string().regex(/^clm_[a-z0-9_]{3,60}$/);
export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// Hierarquia de confiança. Fonte primária = quem fabrica, regula ou normatiza.
export const SourceClass = z.enum([
  'manufacturer', // ficha técnica, manual, site oficial da marca
  'regulator', // Inmetro, Anvisa, MTE, Diário Oficial
  'standard_body', // ABNT, ISO, BIFMA (texto ou resumo oficial)
  'independent_test', // laboratório ou entidade de teste publicada (ex.: Proteste)
  'retailer_listing', // anúncio de loja: só serve para disponibilidade/snapshot, nunca para especificação
  'other',
]);
export type SourceClass = z.infer<typeof SourceClass>;

// Tag de afiliado da conta Amazon Associados (StoreID).
export const AFFILIATE_TAG = 'tarasconi-20';
export const affiliateUrl = (asin: string) => `https://www.amazon.com.br/dp/${asin}?tag=${AFFILIATE_TAG}`;

export const PRIMARY_CLASSES: readonly SourceClass[] = ['manufacturer', 'regulator', 'standard_body'];

// Snapshot imutável de uma fonte. O texto extraído fica em disco ao lado do bruto.
export const Source = z.object({
  id: SourceId,
  url: z.url(),
  final_url: z.url(),
  fetched_at: z.iso.datetime(),
  http_status: z.number().int(),
  content_type: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  raw_file: z.string(),
  text_file: z.string(),
  text_chars: z.number().int().nonnegative(),
  extractor_version: z.number().int().positive().default(1),
  title: z.string().nullable(),
  publisher: z.string().min(2),
  source_class: SourceClass,
  note: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const ClaimType = z.enum([
  'spec', // dado técnico declarado (densidade, dimensões, carga)
  'certification', // certificação/registro de um produto
  'regulation', // o que uma norma ou portaria exige
  'definition', // definição de termo técnico
  'availability', // produto listado em loja numa data (não é especificação)
]);

// Tipo de produto: vocabulário definido pelo perfil de nicho (data/niche.json), não pelo código.
export const ProductKind = z.string().regex(/^[a-z0-9_]+$/);

// Tudo que é específico do nicho mora aqui. Trocar de nicho = trocar este perfil e o cadastro de domínios.
export const NicheProfile = z.object({
  brand: z.string().min(2),
  site_tagline: z.string(),
  site_intro: z.string(),
  scope: z.string().min(10),
  audience: z.string().min(5),
  category_label: z.string(),
  regulator_hints: z.array(z.string()).min(1),
  safety_rule: z.string().min(20),
  decision_outline: z.array(z.string()).min(2),
  product_kinds: z.array(z.object({ id: ProductKind, label: z.string() })).min(1),
  // Termos que o site nunca exibe, nem citando vendedor (aplicado a trechos de anúncio).
  forbidden_terms: z.array(z.string()).default([]),
});
export type NicheProfile = z.infer<typeof NicheProfile>;

// Pauta: o que a página precisa responder e de onde pode tirar a resposta.
// Hoje escrita pelo PM; na Fase 3 gerada pelo estágio discover.
export const TopicBrief = z.object({
  slug: Slug,
  primary_query: z.string().min(3),
  page_type: z.enum(['decision_compare', 'buying_guide', 'explainer']),
  questions: z
    .array(z.object({ id: z.string().regex(/^q_[a-z0-9_]+$/), text: z.string().min(10) }))
    .min(1),
  // Pode nascer vazia: o estágio discover preenche.
  source_ids: z.array(SourceId).default([]),
  editorial_notes: z.array(z.string()).default([]),
  // Termos que um trecho de fonte precisa conter para valer a leitura pelo extrator (economia).
  // Vazio = palavras da dúvida principal.
  focus_terms: z.array(z.string()).default([]),
  // Memória da pauta, escrita pelo motor: o que a revisão disse que faltou, fontes já lidas pela
  // pesquisa (não reler) e tentativas de melhoria (limite para não gastar sem fim).
  evidence_gaps: z.array(z.string()).default([]),
  researched_source_ids: z.array(SourceId).default([]),
  improve_attempts: z.number().int().nonnegative().default(0),
  // Tipos de produto que a página explica; só esses podem aparecer como exemplos à venda.
  product_kinds: z.array(ProductKind).default([]),
});
export type TopicBrief = z.infer<typeof TopicBrief>;

// Uma evidência é um trecho literal de um snapshot. A paráfrase é opcional e não é a prova.
export const Claim = z.object({
  id: ClaimId,
  source_id: SourceId,
  quote: z.string().min(12).max(1200),
  claim_type: ClaimType,
  statement: z.string().min(8).max(400),
  captured_at: z.iso.datetime(),
  // Pergunta da pauta que este trecho responde; um claim pode servir a mais de uma página.
  question_ids: z.array(z.string()).default([]),
  run_id: z.string().optional(),
});
export type Claim = z.infer<typeof Claim>;

// Bloco de texto. `basis` torna explícito o que é fato citado e o que é raciocínio.
const ClaimRefs = z.array(ClaimId);
export const Basis = z.enum([
  'evidence', // afirma fatos; cada fato precisa estar nas evidências citadas
  'reasoning', // conclusão derivada das evidências citadas (precisa citar ao menos uma)
  'framing', // contexto sem fatos verificáveis (pergunta, transição); não pode citar nem afirmar fatos
]);

export const Paragraph = z.object({
  kind: z.literal('paragraph'),
  text: z.string().min(1),
  basis: Basis,
  claim_ids: ClaimRefs,
});

export const TableCell = z.object({ text: z.string(), claim_ids: ClaimRefs });
export const Table = z.object({
  kind: z.literal('table'),
  caption: z.string(),
  columns: z.array(z.string()).min(2),
  rows: z.array(z.object({ cells: z.array(TableCell) })).min(1),
});

export const Callout = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['info', 'warning']),
  text: z.string().min(1),
  basis: Basis,
  claim_ids: ClaimRefs,
});

export const Block = z.discriminatedUnion('kind', [Paragraph, Table, Callout]);
export type Block = z.infer<typeof Block>;

export const Section = z.object({
  id: Slug,
  heading: z.string().min(2),
  blocks: z.array(Block).min(1),
});

export const ProductRef = z.object({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  label: z.string(),
  // Por que este produto aparece: precisa estar sustentado por evidência (ex.: spec do fabricante).
  claim_ids: ClaimRefs.min(1),
});

// Catálogo de afiliados. Um produto só entra com duas provas: especificação em página do fabricante
// (claim spec/certification de fonte manufacturer) e disponibilidade em anúncio capturado (availability).
export const Product = z.object({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  // Nome neutro (marca + modelo + tamanho). Sem adjetivo promocional: o gate barra "melhor", "top" etc.
  label: z.string().min(5).max(80),
  brand: z.string().min(2),
  kind: ProductKind,
  // "manufacturer": especificações da ficha oficial. "listing": sem ficha oficial; o cartão só mostra o
  // tipo como "anunciado como", citando o anúncio (quem afirma é o vendedor), e nenhuma especificação.
  evidence: z.enum(['manufacturer', 'listing']).default('manufacturer'),
  spec_claim_ids: z.array(ClaimId),
  availability_claim_id: ClaimId,
  added_at: z.iso.date(),
});
export type Product = z.infer<typeof Product>;

export const PageStatus = z.enum(['draft', 'approved', 'published']);

export const PageSpec = z.object({
  slug: Slug,
  page_type: z.enum(['decision_compare', 'buying_guide', 'explainer']),
  status: PageStatus,
  title: z.string().min(10).max(70),
  description: z.string().min(50).max(160),
  primary_query: z.string().min(3),
  updated_at: z.iso.date(),
  verdict: z.object({ text: z.string().min(20), basis: Basis, claim_ids: ClaimRefs }),
  sections: z.array(Section).min(1),
  products: z.array(ProductRef).default([]),
  // Registro de auditoria: quem gerou e quem aprovou. Preenchido pelo motor, não à mão.
  provenance: z.object({
    run_id: z.string(),
    writer_model: z.string(),
    auditor_model: z.string().nullable(),
    audit_verdict: z.enum(['pass', 'fail', 'pending']),
  }),
});
export type PageSpec = z.infer<typeof PageSpec>;
