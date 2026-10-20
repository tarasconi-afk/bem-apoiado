# Trocar de nicho

O motor não sabe nada de colchão no código. Tudo que é do tema mora em dois arquivos:

| Arquivo | O que define |
|---|---|
| `data/niche.json` | marca, escopo, público, reguladores típicos, **regra de segurança** do tema, estrutura da página de decisão, tipos de produto |
| `data/registry/domains.json` | domínios aceitos como fonte (regulador, norma, fabricante, teste independente) e domínios bloqueados |

O resto (pautas, fontes, evidências, páginas) é gerado pelo motor em `data/`.

Para um nicho novo (ex.: brinquedos), o mínimo é:
1. novo `niche.json` (ex.: reguladores: Inmetro, certificação compulsória de brinquedos; regra de segurança:
   nunca afirmar que um brinquedo é seguro para idade diferente da indicada pelo fabricante/certificação);
2. novo cadastro de domínios (fabricantes do setor, órgãos, normas);
3. pautas (`data/topics/`): dúvida principal + perguntas.

Planejado: comando `niche bootstrap "<tema>"` em que o próprio motor pesquisa e PROPÕE os dois arquivos
para aprovação humana, e geração automática das perguntas de cada pauta.

O aprendizado (`engine learning`) é recalculado do histórico em `data/` e vale para qualquer nicho.
