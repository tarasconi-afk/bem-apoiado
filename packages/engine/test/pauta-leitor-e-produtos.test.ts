import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// 12/11: perguntas do leitor na pauta (travesseiro de pena ou fibra saiu só sobre lavagem) e busca de produtos
// (jogo de lençol recusado como kit; marca escrita no anúncio lida como vazia).
const root = mkdtempSync(join(tmpdir(), 'bem-leitor-'));
process.env.BEM_ROOT = root;
process.env.NEXOS_API_KEY = 'test';

beforeAll(() => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bem-apoiado' }));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/niche.json'), JSON.stringify({
    brand: 'Site Teste', site_tagline: 't', site_intro: 'i', scope: 'compras de cama, mesa e banho', audience: 'quem compra para casa',
    category_label: 'Casa', regulator_hints: ['Inmetro'], safety_rule: 'Segurança: nunca prometer benefício terapêutico.',
    decision_outline: ['tipos', 'Como decidir'],
    product_kinds: [
      { id: 'travesseiro', label: 'Travesseiro', body_contact: true },
      { id: 'jogo_de_cama', label: 'Lençol e jogo de cama', body_contact: true, sold_as_set: true },
      { id: 'edredom', label: 'Edredom', body_contact: true },
      { id: 'toalha', label: 'Toalha de banho', body_contact: true, sold_as_set: true },
      { id: 'cadeira', label: 'Cadeira' },
      { id: 'espuma', label: 'Colchão de espuma', body_contact: true },
    ],
  }));
});

// As 6 perguntas com que a pauta real "travesseiro de pena de ganso ou de fibra" nasceu em 28/10.
const TRAVESSEIRO = [
  'Qual instrução de lavagem e conservação constante na etiqueta têxtil (Inmetro) indica se o comprador deve optar por travesseiro de pena de ganso ou de fibra, e quais são as orientações específicas para cada um?',
  'Qual percentual de penas e plumas de ganso e qual gramatura de enchimento os fabricantes declaram na ficha técnica para travesseiro de pena de ganso?',
  'Qual tipo de fibra sintética e qual gramatura de enchimento os fabricantes declaram na ficha técnica para travesseiro de fibra?',
  'Quais dimensões (comprimento e largura) os fabricantes informam para o travesseiro de pena de ganso e para o travesseiro de fibra?',
  'Quais informações sobre composição de fibras a etiquetagem têxtil do Inmetro exige que apareçam no travesseiro de pena de ganso e no travesseiro de fibra?',
  'O que os fabricantes declaram sobre tempo de vida útil ou recomendação de troca para travesseiro de pena de ganso e para travesseiro de fibra?',
].map((text, i) => ({ id: `q_t${i + 1}`, text, focus: (i === 0 ? 'dado_que_decide' : 'etiqueta_ficha') as 'dado_que_decide' | 'etiqueta_ficha' }));

describe('perguntas do leitor na pauta', () => {
  it('travesseiro: pauta só de etiqueta/ficha ganha uma pergunta de uso e uma de restrição, sem passar de 7', async () => {
    const { ensureReaderQuestions, COVERS_RESTRICTION, COVERS_USE } = await import('../src/stages/plan.ts');
    const r = ensureReaderQuestions('travesseiro de pena de ganso ou de fibra', 'decision_compare', true, TRAVESSEIRO);
    expect(r.questions.length).toBeLessThanOrEqual(7);
    expect(r.questions[0]!.id).toBe('q_t1'); // o dado que decide fica
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    expect(r.questions.some((q) => COVERS_USE.test(fold(q.text)))).toBe(true);
    expect(r.questions.some((q) => COVERS_RESTRICTION.test(fold(q.text)))).toBe(true);
    expect(r.added).toHaveLength(2);
    // Sem alegação terapêutica no modelo fixo.
    expect(r.questions.filter((q) => q.id.endsWith('_leitor')).map((q) => q.text).join(' ')).not.toMatch(/\b(dor|dores|ronco|postura|terap\w*|cura|alivi\w*|saudável)\b/i);
  });

  it('com 7 perguntas, sai a última de etiqueta/ficha, nunca a primeira', async () => {
    const { ensureReaderQuestions } = await import('../src/stages/plan.ts');
    const sete = [...TRAVESSEIRO, { id: 'q_t7', text: 'Qual gramatura mínima a etiqueta precisa declarar para o enchimento de cada travesseiro?', focus: 'etiqueta_ficha' as const }];
    const r = ensureReaderQuestions('travesseiro de pena de ganso ou de fibra', 'decision_compare', true, sete);
    expect(r.questions).toHaveLength(7);
    expect(r.questions[0]!.id).toBe('q_t1');
    expect(r.questions.map((q) => q.id)).toEqual(expect.arrayContaining(['q_uso_leitor', 'q_restricao_leitor']));
    expect(r.added.every((a) => a.includes('no lugar de'))).toBe(true);
  });

  it('pauta que já cobre uso e restrição não muda; produto sem contato com o corpo não pede restrição; explainer não muda', async () => {
    const { ensureReaderQuestions } = await import('../src/stages/plan.ts');
    const cobertas = [
      ...TRAVESSEIRO.slice(0, 4),
      { id: 'q_x', text: 'O que os fabricantes declaram sobre maciez e sustentação de cada travesseiro?', focus: 'uso' as const },
      { id: 'q_y', text: 'O que os fabricantes informam sobre ácaros e alergia em travesseiro de pena e de fibra?', focus: 'restricao' as const },
    ];
    expect(ensureReaderQuestions('travesseiro de pena ou fibra', 'decision_compare', true, cobertas).added).toEqual([]);
    const cadeira = ensureReaderQuestions('cadeira de tela ou de espuma', 'buying_guide', false, TRAVESSEIRO.slice(0, 4));
    expect(cadeira.added).toHaveLength(1);
    expect(cadeira.questions.some((q) => q.id === 'q_restricao_leitor')).toBe(false);
    expect(ensureReaderQuestions('o que é D33', 'explainer', true, TRAVESSEIRO).added).toEqual([]);
  });

  it('planTopic aplica a regra pelo body_contact do tipo e devolve o que acrescentou', async () => {
    const { planTopic } = await import('../src/stages/plan.ts');
    const reply = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      page_type: 'decision_compare', questions: TRAVESSEIRO.map(({ id, text }) => ({ id, text })),
      focus_terms: ['pena', 'fibra'], product_kinds: ['travesseiro'], editorial_notes: [],
    }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const { topic, added } = await planTopic('travesseiro de pena de ganso ou de fibra', reply);
    expect(added).toHaveLength(2);
    expect(topic.questions.length).toBeLessThanOrEqual(7);
    expect(topic.questions.map((q) => q.id)).toEqual(expect.arrayContaining(['q_uso_leitor', 'q_restricao_leitor']));
    expect(Object.keys(topic.questions[0]!)).toEqual(['id', 'text']); // o rótulo não vai para a pauta gravada
  });
});

describe('busca de produtos: marca literal e jogo do próprio tipo', () => {
  it('lê a marca escrita no anúncio (trechos reais de 07-12/11 recusados como "marca genérica")', async () => {
    const { brandFromListing, brandProblem } = await import('../src/stages/products.ts');
    // B07R21BP97 (roupão): extrator devolveu vazio.
    expect(brandFromListing('## Atalhos do teclado\n[Marca: Allstate](/s/ref=bl_sl_s_ap_web_17365811011?ie=UTF8&node=17365811011&field-brandtextbin=Allstate)\n# ROUPÃO DE BANHO PIQUE ADULTO C/FITA 100% ALGODÃO Salmon Tam. GG')).toEqual({ brand: 'Allstate', strong: true });
    // B0DSJ77GG2 (cobertor): marca com espaço codificada no link.
    expect(brandFromListing('# Cobertor de waffle Queen 100% algodão orgânico\nbrandtextbin=Salt+Earth)').brand).toBe('Salt Earth');
    // B0F1PK1QHN (jogo de lençol): tabela de especificações.
    expect(brandFromListing('# Jogo de Lençol Malha 100% Algodão com Elástico 2 e 3 Peças Liso (Azul Bebe, Casal)\nVisite a loja Camaria\n| Marca | Camaria |\nNome da marca | Camaria |')).toEqual({ brand: 'Camaria', strong: true });
    // Só a loja: preenche marca vazia, mas não manda sobre a leitura do modelo.
    expect(brandFromListing('# Toalha\n[Visite a loja Buddemeyer](/stores/x)')).toEqual({ brand: 'Buddemeyer', strong: false });
    expect(brandFromListing('# Toalha sem nada')).toEqual({ brand: '', strong: false });
    // "Genérico" volta literal e continua recusado; vazio tem motivo próprio.
    const gen = brandFromListing('# Jogo de Toalhas Banhão Gigante 4 Peças\n[Marca: Genérico](/s?field-brandtextbin=Gen%C3%A9rico)').brand;
    expect(gen).toBe('Genérico');
    expect(brandProblem(gen, 'Toalha de banho')).toMatch(/genérica/);
    expect(brandProblem('', 'Toalha de banho')).toMatch(/sem marca identificada/);
    expect(brandProblem('Camaria', 'Lençol e jogo de cama')).toBeNull();
  });

  it('jogo de lençol e jogo de toalhas contam como o produto; junto com outro tipo, não', async () => {
    const { setOfOwnKind } = await import('../src/stages/products.ts');
    expect(setOfOwnKind('Jogo de Lençol Malha 100% Algodão com Elástico 2 e 3 Peças Liso (Azul Bebe, Casal)', 'jogo_de_cama')).toBe(true);
    expect(setOfOwnKind('Jogo de Lençol 100% Algodão com Fronhas, Malha Penteada 130g, Vários Tamanhos (Queen)', 'jogo_de_cama')).toBe(true);
    expect(setOfOwnKind('Jogo/Kit 2 Toalhas de Banho + 2 Toalhas de Rosto Fio Penteado 520g/m²', 'toalha')).toBe(true);
    expect(setOfOwnKind('Jogo de Cama Casal 4 peças com Edredom Dupla Face', 'jogo_de_cama')).toBe(false);
    expect(setOfOwnKind('Kit 2 Travesseiros de Fibra', 'travesseiro')).toBe(false); // tipo sem sold_as_set
  });
});
