import './env.ts';
import { secret } from './secrets.ts';
import { addSpend } from './llm.ts';

// Jev (TypeSafe, via Hostinger AI Router): modelo de DECISÃO tipada, não de texto. Muito barato
// (~0,0016 crédito por decisão de ~400 tokens). Usado só como TRIAGEM antes das etapas caras;
// nunca substitui o verificador literal, o auditor ou o gate.

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Decider = (state: string, questions: Record<string, ChoiceQuestion>) => Promise<Record<string, ChoiceAnswer>>;

export const jevDecide: Decider = async (state, questions) => {
  const key = secret('llm');
  const base = (process.env.NEXOS_BASE_URL ?? 'https://router.hostinger.com/v1').replace(/\/$/, '');
  if (!key) throw new Error('NEXOS_API_KEY ausente');
  const res = await fetch(`${base}/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: state.slice(0, 60_000), questions }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { answers?: Record<string, ChoiceAnswer>; usage?: { credits_charged?: number } };
  addSpend(body.usage?.credits_charged ?? 0, 'jev', 'jev-latest');
  return body.answers ?? {};
};

// Pergunta padrão de utilidade: o trecho/página ajuda a responder alguma pergunta da pauta?
export function usefulnessQuestion(primaryQuery: string, questions: string[]): Record<string, ChoiceQuestion> {
  return {
    util: {
      type: 'choice',
      instructions:
        `Este conteúdo traz informação concreta (definição, requisito, número, tabela, especificação, regra) ` +
        `que ajuda a responder alguma destas perguntas sobre "${primaryQuery}"? ` + questions.map((q) => `(${q})`).join(' '),
      criteria: {
        sim: 'traz informação concreta que responde a pelo menos uma das perguntas',
        nao: 'não traz: é garantia, institucional, marketing genérico, navegação, outro assunto ou só menciona o tema',
      },
    },
  };
}
