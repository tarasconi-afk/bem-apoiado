import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callJson, type FetchLike } from './llm.ts';
import { DATA, writeJson } from './store.ts';

// Lições do editor (data/editor-lessons.json): pedido de ajuste salvo ou recusa com motivo que vale para
// TODAS as páginas vira regra curta. Redator, planejador da pauta e busca de fontes recebem a lista.
// 21/10: os pedidos do editor corrigiam só a página pedida e o motor repetia o erro na seguinte.

export const EDITOR_LESSONS_FILE = join(DATA, 'editor-lessons.json');
const MAX_LESSONS = 12;

export const EditorLessons = z.object({ lessons: z.array(z.object({ text: z.string(), from: z.string(), at: z.string() })).default([]) });
export type EditorLessons = z.infer<typeof EditorLessons>;

// Cada ajuste roda num ramo próprio, então o 2º não enxerga a lição que o 1º acabou de gravar noutro ramo e o
// "already_covered" do modelo não tem como pegar (27/10: duas regras sobre o mesmo assunto, 24 min de diferença).
// O git também junta as duas listas no merge e o teto de 12 estoura: a lista tinha 15.
// Só texto igual é cortado aqui. Tentei medir semelhança por palavras em comum e, no teste contra as 15 lições
// reais, o limiar que pegava a paráfrase também apagava uma regra legítima ("o Como decidir traz uma orientação
// para cada caso que a resposta curta cita"): apagar conhecimento em silêncio é pior que uma regra repetida.
// Paráfrase quem tira é o editor, com o botão "remover" da lista de lições (painel, aba Conteúdo).
const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function dedupeLessons<L extends { text: string }>(list: L[], limit = MAX_LESSONS): L[] {
  const seen = new Set<string>();
  return list.filter((l) => (seen.has(norm(l.text)) ? false : (seen.add(norm(l.text)), true))).slice(0, limit);
}

export function loadEditorLessons(): EditorLessons {
  const raw = existsSync(EDITOR_LESSONS_FILE) ? EditorLessons.parse(JSON.parse(readFileSync(EDITOR_LESSONS_FILE, 'utf8'))) : EditorLessons.parse({});
  return { lessons: dedupeLessons(raw.lessons) };
}

const Out = z.object({ general: z.boolean(), lesson: z.string().nullable(), already_covered: z.boolean() });

export async function learnFromEditor(slug: string, request: string, fetchImpl?: FetchLike, now = new Date()): Promise<string | null> {
  const cur = loadEditorLessons();
  const r = await callJson(
    {
      role: 'extractor',
      system:
        'Você transforma pedidos do editor de um site de guias de compra em regras para o redator. Se o pedido vale para TODAS as páginas (tom, linguagem, foco no comprador, como apresentar fontes, estrutura, o que pesquisar e em que tipo de fonte), escreva UMA regra curta e geral (até 200 caracteres, imperativa, sem citar a página, o produto ou números dela) e general=true. Se é específico desta página (um dado, um trecho, um produto), general=false e lesson=null. already_covered=true só se uma regra atual já diz a MESMA coisa (regra sobre pesquisa não está coberta por regra sobre texto, e vice-versa).',
      user: `Página: ${slug}\nPedido do editor: ${request.slice(0, 1200)}\n\nRegras atuais:\n${cur.lessons.map((l) => `- ${l.text}`).join('\n') || '(nenhuma)'}`,
      schema: Out,
      schemaName: 'editor_lesson',
      maxTokens: 300,
    },
    fetchImpl,
  );
  const text = r.data.lesson?.replace(/\s+/g, ' ').trim();
  if (!r.data.general || r.data.already_covered || !text || text.length < 15 || text.length > 240) return null;
  const lessons = dedupeLessons([{ text, from: `editor: ${slug}`, at: now.toISOString() }, ...cur.lessons]);
  // A nova repete uma que já existe (outras palavras, mesma regra): nada muda e o editor não ganha lição duplicada.
  if (lessons.length === cur.lessons.length && lessons.every((l, i) => l.text === cur.lessons[i]?.text)) return null;
  writeJson(EDITOR_LESSONS_FILE, { lessons });
  return text;
}

export function editorLessonsPrompt(): string {
  const l = loadEditorLessons().lessons;
  return l.length ? `\n\nPedidos do editor que valem para todas as páginas (siga desde a primeira versão):\n${l.map((x) => `- ${x.text}`).join('\n')}` : '';
}

// Id curto e estável de uma lição (para o botão "remover" do painel).
export const lessonId = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 10);

export function removeEditorLesson(id: string): string | null {
  const cur = loadEditorLessons();
  const hit = cur.lessons.find((l) => lessonId(l.text) === id);
  if (!hit) return null;
  writeJson(EDITOR_LESSONS_FILE, { lessons: cur.lessons.filter((l) => l !== hit) });
  return hit.text;
}
