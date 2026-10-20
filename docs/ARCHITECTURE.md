# Arquitetura

Um repositório, uma linguagem (TypeScript), um lugar para estado (`data/`, versionado).

```
packages/core     schemas Zod (Source, Claim, PageSpec) + verificação de integridade. Puro, sem I/O.
packages/engine   I/O: snapshot de fontes, armazenamento em data/, CLI, (futuro) estágios com LLM.
site/             Astro estático. Lê data/ através do engine e dos schemas do core.
data/sources/     <src_id>/{meta.json, raw.(html|pdf), text.txt}  snapshot imutável e com hash
data/claims/      <clm_id>.json  trecho literal + tipo + paráfrase
data/pages/       <slug>.json    PageSpec
data/runs/        <run_id>/<estágio>.json  entrada e saída de cada estágio, para auditoria e retomada
```

## Fluxo de uma página

1. **discover**: escolhe pauta (Planner/autocomplete agora, Search Console depois). *(futuro)*
2. **research**: busca fontes primárias, faz `snapshot`, extrai candidatos a `claim` (LLM propõe o
   trecho, código confere que o trecho existe literalmente no snapshot). *(próximo)*
3. **write**: LLM redator recebe só os claims aprovados e devolve PageSpec com `claim_ids` de lista fechada.
4. **audit**: LLM de outro fornecedor julga, bloco a bloco, se o texto é sustentado pelos trechos
   citados (SUPPORTED / OVERSTATED / UNSUPPORTED). Qualquer coisa diferente de SUPPORTED volta para write.
5. **gate**: `validate` determinístico (referências, trechos literais, classe da fonte, números citados).
6. **publish**: abre PR com a página e o relatório. Merge = publicar. Deploy estático na Hostinger.

Cada estágio é uma função `(entrada JSON) -> saída JSON` gravada em `data/runs/`, então qualquer run
pode ser retomado ou reproduzido a partir do estágio que falhou.

## Onde roda

- Desenvolvimento: local.
- Execução agendada: VPS dedicada `srv2079501` (Ubuntu 24.04, Campinas), timer do systemd.
- Site: hospedagem estática Hostinger (domínio temporário, `noindex`, até o domínio definitivo).
