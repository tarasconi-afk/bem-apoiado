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

export function loadEditorLessons(): EditorLessons {
  return existsSync(EDITOR_LESSONS_FILE) ? EditorLessons.parse(JSON.parse(readFileSync(EDITOR_LESSONS_FILE, 'utf8'))) : EditorLessons.parse({});
}

const Out = z.object({ general: z.boolean(), lesson: z.string().nullable(), already_covered: z.boolean() });

export async function learnFromEditor(slug: string, request: string, fetchImpl?: FetchLike, now = new Date()): Promise<string | null> {
  const cur = loadEditorLessons();
  const r = await callJson(
    {
      role: 'extractor',
      system:
        'Você transforma pedidos do editor de um site de guias de compra em regras para o redator. Se o pedido vale para TODAS as páginas (tom, linguagem, foco no comprador, como apresentar fontes, estrutura, o que pesquisar e em que tipo de fonte), escreva UMA regra curta e geral (até 200 caracteres, imperativa, sem citar a página, o produto ou números dela) e general=true. Se é específico desta página (um dado, um trecho, um produto), general=false e lesson=null. already_covered=true se a regra já está na lista atual.',
      user: `Página: ${slug}\nPedido do editor: ${request.slice(0, 1200)}\n\nRegras atuais:\n${cur.lessons.map((l) => `- ${l.text}`).join('\n') || '(nenhuma)'}`,
      schema: Out,
      schemaName: 'editor_lesson',
      maxTokens: 300,
    },
    fetchImpl,
  );
  const text = r.data.lesson?.replace(/\s+/g, ' ').trim();
  if (!r.data.general || r.data.already_covered || !text || text.length < 15 || text.length > 240) return null;
  const lessons = [{ text, from: `editor: ${slug}`, at: now.toISOString() }, ...cur.lessons].slice(0, MAX_LESSONS);
  writeJson(EDITOR_LESSONS_FILE, { lessons });
  return text;
}

export function editorLessonsPrompt(): string {
  const l = loadEditorLessons().lessons;
  return l.length ? `\n\nPedidos do editor que valem para todas as páginas (siga desde a primeira versão):\n${l.map((x) => `- ${x.text}`).join('\n')}` : '';
}
