import { z } from 'zod';
import type { Claim, PageSpec, Source } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { blockRefs } from './draft-schema.ts';
import { docLabel } from './write.ts';

// Auditoria de coerência da página inteira (24/10). O auditor julga cada bloco contra os próprios trechos e o
// juiz julga a utilidade pergunta por pergunta; nenhum dos dois lê a página como o leitor. Nas 3 páginas novas
// da noite de 23→24/10 o juiz deu 4 de 4 e o editor corrigiu as 3, sempre por um destes problemas. Lista
// fechada: o modelo só pode apontar estes 3, com o bloco e o porquê; nada de opinião geral.

// 27/10, pedido do editor: "a página tem que ter coerência; o sistema lê a página como um todo e revisa como se
// fosse um artigo com começo, meio e fim". Entraram as duas abaixo, cada uma de um erro real que passou por todas
// as outras camadas com o juiz dando 4 de 4: seção prometendo no título o que os blocos não entregam (página do
// protetor: "Tipos de protetor: elástico simples, ajustável e com zíper", e os blocos só falavam de altura) e
// promessa do título ou da resposta curta que a página inteira não cumpre.
export const COHERENCE_CHECKS = ['produto_como_solucao', 'dado_de_produto_vira_regra', 'caso_sem_orientacao', 'secao_nao_entrega', 'promessa_do_titulo'] as const;
export type CoherenceCheck = (typeof COHERENCE_CHECKS)[number];

export const CHECK_LABEL: Record<CoherenceCheck, string> = {
  produto_como_solucao: 'produto apresentado como solução sem que a fonte diga isso',
  dado_de_produto_vira_regra: 'dado de um produto apresentado como regra do tamanho ou do tipo',
  caso_sem_orientacao: 'caso da resposta curta sem orientação no Como decidir',
  secao_nao_entrega: 'título da seção promete o que os blocos dela não trazem',
  promessa_do_titulo: 'o título ou a resposta curta prometem o que a página não cumpre',
};

const system = () => `Você revisa páginas do site ${loadNiche().brand} antes da publicação, lendo a página INTEIRA como o leitor leigo vai ler, do título ao fim, como quem lê um artigo com começo, meio e fim.
Cada bloco já foi auditado sozinho contra os próprios trechos. Você procura só os 5 problemas abaixo, que só aparecem quando se lê a página toda. Não aponte mais nada (estilo, tamanho, falta de dados, jargão): isso é de outra etapa.

1. "produto_como_solucao": a página apresenta um produto, modelo ou tipo como o que resolve o caso do leitor, mas os trechos citados só descrevem uma característica dele, sem dizer que ela resolve ESSE caso; ou a característica, como os trechos a descrevem, não atende o caso. Exemplo real: "para casal com pesos diferentes, o colchão dupla face (um lado mais firme, outro mais macio)". O casal dorme no mesmo lado ao mesmo tempo, então ter dois lados não atende pesos diferentes, e a fonte não diz que atende.
2. "dado_de_produto_vira_regra": uma medida, número ou especificação que nos trechos é de UM produto ou modelo aparece como se valesse para o tamanho, o tipo ou a categoria inteira. Exemplo real: "travesseiro queen mede 50 × 90 cm", quando o trecho é a ficha de um travesseiro específico. Se o bloco diz de qual produto ou fabricante é o dado ("o modelo X da Probel mede…"), NÃO é problema. Medida-padrão de tamanho de cama (solteiro, solteirão, viúva, casal, queen, king) atribuída ao fabricante ("segundo a Probel", "segundo os fabricantes") também NÃO é problema quando os trechos dão essa medida para ESSE mesmo tamanho; é problema quando a medida de um tamanho é estendida a outro (a medida do king virando a do queen) ou quando o dado é de desempenho do modelo (peso suportado, resistência, número de posições) e aparece como dado da categoria.
3. "caso_sem_orientacao": a resposta curta (verdict) ou o título citam um caso ou uma opção (ex.: "solteirão para quem é alto"), e a seção "Como decidir" não diz ao leitor desse caso o que escolher ou o que conferir. Também: uma condição "Se você…" em que a orientação não decide nada (só manda "conferir a ficha" sem dizer o quê).
4. "secao_nao_entrega": o título da seção anuncia algo que os blocos dela não trazem. Exemplo real: seção "Tipos de protetor: elástico simples, ajustável e com zíper" cujos blocos só falam de altura, sem dizer o que é cada tipo. Vale também quando o título promete comparação ou lista e a seção traz um caso só. Aponte no PRIMEIRO bloco da seção, e em "fix" diga qual é a saída: mudar o título para o que a seção realmente traz, ou tirar da promessa o que não existe. Se o que falta não está nos trechos, a saída é sempre mudar o título, nunca inventar o conteúdo.
5. "promessa_do_titulo": o título da página ou a resposta curta prometem ao leitor algo que a página inteira não entrega (comparar duas opções e só falar de uma; prometer "como escolher" e só definir o produto; citar um perfil de comprador que nenhuma seção atende). Aponte em "verdict" e, em "fix", diga o que a página consegue prometer com o que ela tem.

Só aponte o que você conseguir mostrar com o texto do bloco e os trechos. Na dúvida, não aponte. Página sem esses problemas devolve "findings" vazio.
Não aponte 4 nem 5 por falta de dado que nenhuma fonte traria: a saída dessas duas é sempre ajustar a promessa ao que a página tem, não pedir conteúdo novo.
Para cada problema: "ref" do bloco, "problem" em uma frase simples (o que o leitor entenderia errado) e "fix" dizendo o que reescrever, usando só o que os trechos sustentam (ou "tirar o bloco").`;

export interface CoherenceFinding {
  check: CoherenceCheck;
  ref: string;
  problem: string;
  fix: string;
}

export interface CoherenceResult {
  findings: CoherenceFinding[];
  // Texto para o pedido de correção (entra em reader_problems: vira o "texto pronto" e a correção automática).
  problems: string[];
  usage: { input_tokens: number; output_tokens: number; calls: number };
}

type PageLike = Pick<PageSpec, 'title' | 'description' | 'verdict' | 'sections'>;

export async function auditCoherence(
  page: PageLike,
  primaryQuery: string,
  claims: Map<string, Claim>,
  sources: Map<string, Source>,
  fetchImpl?: FetchLike,
): Promise<CoherenceResult> {
  const units = blockRefs({ title: page.title, description: page.description, verdict: page.verdict, sections: page.sections } as never);
  const refs = units.map((u) => u.ref) as [string, ...string[]];
  const Out = z.object({
    findings: z.array(z.object({ check: z.enum(COHERENCE_CHECKS), ref: z.enum(refs), problem: z.string(), fix: z.string() })),
  });
  const sectionOf = new Map(page.sections.map((s) => [s.id, s.heading]));
  const body = units
    .map((u) => {
      const cited = u.claim_ids
        .map((id) => {
          const c = claims.get(id);
          const s = c ? sources.get(c.source_id) : undefined;
          return c ? `    - ${s?.publisher ?? '?'} · ${docLabel(s, c.quote)}: "${c.quote}"` : '';
        })
        .filter(Boolean)
        .join('\n');
      const where = u.ref === 'verdict' ? 'RESPOSTA CURTA' : `seção "${sectionOf.get(u.ref.split('#')[0]!) ?? '?'}"`;
      return `[${u.ref}] (${where}) ${u.text}${cited ? `\n  trechos:\n${cited}` : ''}`;
    })
    .join('\n');
  const ask = () =>
    callJson(
      {
        role: 'auditor',
        system: system(),
        user: `Dúvida de quem buscou: "${primaryQuery}"\nTítulo: ${page.title}\nDescrição: ${page.description}\n\n${body}`,
        schema: Out,
        schemaName: 'coherence',
        maxTokens: 1500,
      },
      fetchImpl,
    );
  // 3 leituras, vale o que a maioria apontou (mesmo problema no mesmo bloco): uma leitura sozinha oscila.
  const runs = (await Promise.allSettled([ask(), ask(), ask()])).flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []));
  if (!runs.length) throw new Error('coerência: nenhuma das 3 leituras voltou');
  const usage = runs.reduce((a, r) => ({ input_tokens: a.input_tokens + r.usage.input_tokens, output_tokens: a.output_tokens + r.usage.output_tokens, calls: a.calls + 1 }), { input_tokens: 0, output_tokens: 0, calls: 0 });
  const findings = coherenceMajority(runs.map((r) => r.data.findings));
  return { findings, problems: findings.map(problemText), usage };
}

// Fica o par (problema, bloco) apontado por mais da metade das leituras; o texto vem da primeira que o apontou.
export function coherenceMajority(votes: CoherenceFinding[][]): CoherenceFinding[] {
  const half = votes.length / 2;
  const key = (f: CoherenceFinding) => `${f.check}|${f.ref}`;
  const first = new Map<string, CoherenceFinding>();
  const count = new Map<string, number>();
  for (const v of votes) {
    for (const k of new Set(v.map(key))) count.set(k, (count.get(k) ?? 0) + 1);
    for (const f of v) if (!first.has(key(f))) first.set(key(f), f);
  }
  return [...first.entries()].filter(([k]) => (count.get(k) ?? 0) > half).map(([, f]) => f);
}

export const problemText = (f: CoherenceFinding) => `${f.problem.replace(/[.\s]+$/, '')} (${f.ref}); ${f.fix.replace(/[.\s]+$/, '')}`.slice(0, 260);
