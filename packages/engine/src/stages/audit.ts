import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Claim, Source } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { loadNiche } from '../niche.ts';
import { blockRefs, type Draft } from './draft-schema.ts';
import { docLabel } from './write.ts';

export const AuditVerdict = z.enum([
  'SUPPORTED', // tudo que o bloco afirma está nos trechos citados
  'OVERSTATED', // a ideia está nas fontes, mas o bloco afirma mais (generaliza, intensifica, quantifica)
  'UNSUPPORTED', // afirma algo que os trechos citados não dizem
  'MISATTRIBUTED', // posição de fabricante apresentada como fato geral, ou fonte errada
  'SAFETY_CLAIM', // viola a regra de segurança do nicho (data/niche.json)
  'FACT_IN_FRAMING', // bloco marcado como framing traz fato
]);

const auditorSystem = () => `Você é o auditor de evidências do site ${loadNiche().brand}. Seu trabalho é desconfiar.

Para cada bloco você recebe o texto publicado e os trechos LITERAIS das evidências que ele cita (com a fonte e a classe da fonte). Julgue cada bloco sozinho, só contra os trechos citados nele, sem usar conhecimento próprio:

- SUPPORTED: cada afirmação do bloco está dita nos trechos citados (paráfrase fiel é aceitável).
- OVERSTATED: a ideia existe nos trechos, mas o bloco afirma mais (generaliza "sempre/todos", intensifica, acrescenta número ou condição). Também: regra de um anexo ou de um setor específico (veja o documento: ex. "anexo II teleatendimento") apresentada como regra geral (dizer o alcance em palavras simples, sem o nome técnico, é correto: "regra para postos de atendimento por telefone"); "é preferível/recomenda" (manual, guia) apresentado como exigência.
- UNSUPPORTED: o bloco afirma algo que nenhum trecho citado diz.
- MISATTRIBUTED: afirmação que nos trechos é posição de um fabricante (classe manufacturer) aparece como fato geral, sem "segundo a <marca>"; ou o bloco atribui a uma fonte o que ela não disse. Também: o bloco situa a afirmação numa parte do documento (anexo, capítulo, setor) que o "trecho em" da evidência não mostra.
- SAFETY_CLAIM: o bloco viola esta regra do site, MESMO quando atribui a afirmação a um fabricante: ${loadNiche().safety_rule}
- FACT_IN_FRAMING: bloco com basis "framing" que afirma algum fato sobre produtos, fontes ou o mundo. Frase de transição que só descreve a própria página ("A seguir, veja o que as fontes dizem sobre X") NÃO é fato: é SUPPORTED.

SAFETY_CLAIM se julga pelo TEXTO do bloco, não pelo conteúdo dos trechos citados: citar um trecho de fabricante que fala de saúde não é violação se o bloco não repete nem sugere a alegação. Orientar a procurar um profissional de saúde é permitido pela regra e não precisa de trecho.

Blocos "reasoning" podem tirar conclusões práticas, desde que a conclusão decorra diretamente dos trechos citados.
Para todo veredito diferente de SUPPORTED, explique em "problem" o que exatamente excede os trechos e proponha em "fix" uma versão mais estreita que os trechos sustentariam.`;

export interface AuditFinding {
  ref: string;
  verdict: z.infer<typeof AuditVerdict>;
  problem: string;
  fix: string;
}

// Chave do cache: o que o auditor julga (texto, basis, citações), sem a posição do bloco na página.
export function auditKey(u: { text: string; basis: string; claim_ids: string[] }): string {
  return createHash('sha256').update(JSON.stringify([u.text, u.basis, [...u.claim_ids].sort()])).digest('hex');
}

export type AuditCache = Map<string, Omit<AuditFinding, 'ref'>>;
// Auditoria por maioria nos reprovados (BEM_AUDIT_MAJORITY=0 desliga, para comparar custo).
export const AUDIT_MAJORITY = process.env.BEM_AUDIT_MAJORITY !== '0';

export async function auditDraft(
  draft: Draft,
  claims: Map<string, Claim>,
  sources: Map<string, Source>,
  fetchImpl?: FetchLike,
  cache: AuditCache = new Map(),
  onlyRefs?: Set<string>,
): Promise<{ findings: AuditFinding[]; usage: { input_tokens: number; output_tokens: number; calls: number }; model: string }> {
  const findings: AuditFinding[] = [];
  // Bloco idêntico já julgado mantém o veredito: economiza chamada e evita oscilação do auditor.
  const units = blockRefs(draft).filter((u) => {
    if (onlyRefs && !onlyRefs.has(u.ref)) return false;
    const hit = cache.get(auditKey(u));
    if (hit) findings.push({ ref: u.ref, ...hit });
    return !hit;
  });
  // Lotes por seção: contexto suficiente para o auditor, sem misturar a página toda numa chamada só.
  const groups = new Map<string, typeof units>();
  for (const u of units) {
    const key = u.ref.split('#')[0]!;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let model = '';

  type Unit = (typeof units)[number];
  type F = { verdict: AuditFinding['verdict']; problem: string; fix: string };
  const ask = async (group: Unit[]): Promise<Map<string, F>> => {
    const refs = group.map((u) => u.ref) as [string, ...string[]];
    const Out = z.object({
      findings: z.array(z.object({ ref: z.enum(refs), verdict: AuditVerdict, problem: z.string(), fix: z.string() })),
    });
    const body = group
      .map((u) => {
        const cited = u.claim_ids
          .map((id) => {
            const c = claims.get(id);
            const s = c ? sources.get(c.source_id) : undefined;
            return c ? `    [${id}] ${s?.publisher ?? '?'} (${s?.source_class ?? '?'}) · documento: ${docLabel(s, c.quote)}: "${c.quote}"` : `    [${id}] (inexistente)`;
          })
          .join('\n');
        return `BLOCO ${u.ref} (basis: ${u.basis})\n  texto: ${u.text}\n  trechos citados:\n${cited || '    (nenhum)'}`;
      })
      .join('\n\n');
    const r = await callJson(
      {
        role: 'auditor',
        system: auditorSystem(),
        user: `Audite cada bloco abaixo e devolva exatamente um veredito por bloco (refs: ${refs.join(', ')}).\n\n${body}`,
        schema: Out,
        schemaName: 'audit',
        maxTokens: 6000,
      },
      fetchImpl,
    );
    usage.calls++;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    model = r.model;
    const m = new Map<string, F>();
    for (const f of r.data.findings) if (!m.has(f.ref)) m.set(f.ref, { verdict: f.verdict, problem: f.problem, fix: f.fix });
    // Bloco sem veredito não conta como aprovado.
    for (const ref of refs) if (!m.has(ref)) m.set(ref, { verdict: 'UNSUPPORTED', problem: 'auditor não devolveu veredito', fix: '' });
    return m;
  };

  for (const group of groups.values()) {
    const first = await ask(group);
    // Maioria nos blocos reprovados (22/10: o auditor mudou de veredito em 15% dos blocos auditando 3 vezes o mesmo
    // rascunho; na página do Bonnel, aprovada pelo editor, 6 de 16 blocos oscilaram). Só o reprovado volta, mais 2
    // vezes; aprovado por 2 de 3 vale como aprovado. O cache guarda o resultado da maioria, não o primeiro voto.
    const failed = group.filter((u) => first.get(u.ref)!.verdict !== 'SUPPORTED');
    const extra = AUDIT_MAJORITY && failed.length ? await Promise.all([ask(failed), ask(failed)]) : [];
    for (const u of group) {
      let f = first.get(u.ref)!;
      if (extra.length && f.verdict !== 'SUPPORTED') {
        const ok = extra.filter((m) => m.get(u.ref)?.verdict === 'SUPPORTED').length;
        if (ok >= 2) f = { verdict: 'SUPPORTED', problem: '', fix: '' };
      }
      findings.push({ ref: u.ref, ...f });
      cache.set(auditKey(u), f);
    }
  }
  return { findings, usage, model };
}
