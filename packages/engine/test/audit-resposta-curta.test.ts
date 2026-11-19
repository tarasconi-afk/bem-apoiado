import { describe, expect, it } from 'vitest';

// 19/11: a resposta curta só é sustentada com dois votos a favor (trazido do FC; serra mármore: três versões aprovadas com número
// trocado entre modelos porque um único "sustentado" bastava). Os outros blocos seguem a regra antiga.
process.env.NEXOS_API_KEY = 'chave-de-teste';


const auditorCom = (votosDaResposta: string[]) => {
  let n = 0;
  const pedidos: string[][] = [];
  const f = async (_url: string | URL | Request, init?: RequestInit) => {
    const refs = /refs: ([^)]+)\)/.exec(JSON.parse(String(init?.body)).messages.at(-1).content)![1]!.split(', ');
    pedidos.push(refs);
    const findings = refs.map((ref) => {
      const v = ref === 'verdict' ? votosDaResposta[n++] ?? 'SUPPORTED' : 'SUPPORTED';
      return { ref, verdict: v, problem: v === 'SUPPORTED' ? '' : 'a 4100NH3Z corta 32 mm, não 34 mm', fix: v === 'SUPPORTED' ? '' : 'A Makita 4100NH3Z corta até 32 mm.' };
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
  };
  return { f, pedidos };
};
const rascunho = () => ({ title: 't', description: 'd', verdict: { text: 'Até 34 mm: Tramontina 42506 ou Makita 4100NH3Z.', basis: 'framing', claim_ids: [] }, sections: [{ id: 's', heading: 'S', blocks: [{ kind: 'paragraph', text: 'Bloco.', basis: 'framing', claim_ids: [] }] }] }) as never;

describe('resposta curta precisa de duas aprovações do auditor', () => {
  it('dois votos a favor: sustentada, com uma chamada a mais só para a resposta curta', async () => {
    const { auditDraft } = await import('../src/stages/audit.ts');
    const a = auditorCom(['SUPPORTED', 'SUPPORTED']);
    const r = await auditDraft(rascunho(), new Map(), new Map(), a.f);
    expect(r.findings.find((x) => x.ref === 'verdict')!.verdict).toBe('SUPPORTED');
    expect(a.pedidos.filter((p) => p.includes('verdict')).length).toBe(2);
    expect(a.pedidos.filter((p) => p.includes('s#0')).length).toBe(1);
  });
  it('1º a favor e 2º e 3º contra: reprovada, com a correção que as fontes sustentam', async () => {
    const { auditDraft } = await import('../src/stages/audit.ts');
    const r = await auditDraft(rascunho(), new Map(), new Map(), auditorCom(['SUPPORTED', 'OVERSTATED', 'OVERSTATED']).f);
    const v = r.findings.find((x) => x.ref === 'verdict')!;
    expect(v.verdict).toBe('OVERSTATED');
    expect(v.fix).toContain('32 mm');
  });
  it('desempate a favor (2 de 3): sustentada', async () => {
    const { auditDraft } = await import('../src/stages/audit.ts');
    const r = await auditDraft(rascunho(), new Map(), new Map(), auditorCom(['SUPPORTED', 'OVERSTATED', 'SUPPORTED']).f);
    expect(r.findings.find((x) => x.ref === 'verdict')!.verdict).toBe('SUPPORTED');
  });
});
