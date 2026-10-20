import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Claim, Source } from '@bem-apoiado/core';
import { callJson, type FetchLike } from '../llm.ts';
import { blockRefs, type Draft } from './draft-schema.ts';

export const AuditVerdict = z.enum([
  'SUPPORTED', // tudo que o bloco afirma está nos trechos citados
  'OVERSTATED', // a ideia está nas fontes, mas o bloco afirma mais (generaliza, intensifica, quantifica)
  'UNSUPPORTED', // afirma algo que os trechos citados não dizem
  'MISATTRIBUTED', // posição de fabricante apresentada como fato geral, ou fonte errada
  'HEALTH_CLAIM', // promete ou sugere efeito sobre saúde
  'FACT_IN_FRAMING', // bloco marcado como framing traz fato
]);

const SYSTEM = `Você é o auditor de evidências do site Bem Apoiado. Seu trabalho é desconfiar.

Para cada bloco você recebe o texto publicado e os trechos LITERAIS das evidências que ele cita (com a fonte e a classe da fonte). Julgue cada bloco sozinho, só contra os trechos citados nele, sem usar conhecimento próprio:

- SUPPORTED: cada afirmação do bloco está dita nos trechos citados (paráfrase fiel é aceitável).
- OVERSTATED: a ideia existe nos trechos, mas o bloco afirma mais (generaliza "sempre/todos", intensifica, acrescenta número ou condição).
- UNSUPPORTED: o bloco afirma algo que nenhum trecho citado diz.
- MISATTRIBUTED: afirmação que nos trechos é posição de um fabricante (classe manufacturer) aparece como fato geral, sem "segundo a <marca>"; ou o bloco atribui a uma fonte o que ela não disse.
- HEALTH_CLAIM: o bloco diz ou sugere efeito de um colchão sobre dor, coluna, postura ou outra condição de saúde, MESMO quando atribuído a um fabricante (\"segundo a marca X, causa desalinhamento\" também é HEALTH_CLAIM). Dizer que o Inmetro não avalia propriedades terapêuticas não é HEALTH_CLAIM.
- FACT_IN_FRAMING: bloco com basis "framing" que afirma algum fato.

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

export async function auditDraft(
  draft: Draft,
  claims: Map<string, Claim>,
  sources: Map<string, Source>,
  fetchImpl?: FetchLike,
  cache: AuditCache = new Map(),
): Promise<{ findings: AuditFinding[]; usage: { input_tokens: number; output_tokens: number; calls: number }; model: string }> {
  const findings: AuditFinding[] = [];
  // Bloco idêntico já julgado mantém o veredito: economiza chamada e evita oscilação do auditor.
  const units = blockRefs(draft).filter((u) => {
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

  for (const group of groups.values()) {
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
            return c ? `    [${id}] ${s?.publisher ?? '?'} (${s?.source_class ?? '?'}): "${c.quote}"` : `    [${id}] (inexistente)`;
          })
          .join('\n');
        return `BLOCO ${u.ref} (basis: ${u.basis})\n  texto: ${u.text}\n  trechos citados:\n${cited || '    (nenhum)'}`;
      })
      .join('\n\n');
    const r = await callJson(
      {
        role: 'auditor',
        system: SYSTEM,
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
    const seen = new Set<string>();
    for (const f of r.data.findings) {
      if (seen.has(f.ref)) continue;
      seen.add(f.ref);
      findings.push(f);
      const unit = group.find((u) => u.ref === f.ref)!;
      cache.set(auditKey(unit), { verdict: f.verdict, problem: f.problem, fix: f.fix });
    }
    // Bloco sem veredito não conta como aprovado.
    for (const ref of refs) {
      if (!seen.has(ref)) findings.push({ ref, verdict: 'UNSUPPORTED', problem: 'auditor não devolveu veredito', fix: '' });
    }
  }
  return { findings, usage, model };
}
