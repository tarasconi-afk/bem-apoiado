# Auditoria do motor: por que as pautas não aprovam de primeira (27/10/2026)

Pedido do dono: ver o motivo das falhas, corrigir, evitar que se repitam e pensar no melhor sistema para
aprovação de primeira a cada ciclo. Dados: todos os `data/runs/*/page.json` desde 20/10 e os registros
(auditoria, coerência, revisão) das 4 pautas que falharam em 26 e 27/10.

## Números (runs de página nova e de reescrita, 20 a 27/10)

| Resultado | Runs | Causa |
|---|---|---|
| PASS | 16 | |
| SAFE_STOP | 19 | auditoria de evidências não convergiu em 4 rodadas |
| NOT_PUBLISHABLE | 8 | revisão de leitor (não decide, sem resposta rápida, não é para leigo) |
| NOT_PUBLISHABLE | 4 | coerência (juiz deu 4 de 4; a página generalizava dado de produto ou vendia produto como solução) |
| NOT_PUBLISHABLE | 3 | regra de enchimento/critérios |
| SAFE_STOP | 5 | saída inválida do modelo, HTTP, orçamento |

Aprovação de primeira: **16 de 55 = 29%**. Os ajustes pedidos pelo editor (30 runs `EDITOR_ADJUST`) ficam fora.

## As 4 falhas de 26 e 27/10, uma a uma

1. **Colchão D45 é muito duro (SAFE_STOP).** A auditoria estava convergindo (10 → 5 blocos reprovados). Na 3ª
   rodada o redator copiou a "versão sustentável" do auditor para a resposta curta, que começava com "Segundo a
   Castor, …"; a regra de forma do site barrou a rodada antes da auditoria, a 4ª rodada não existiu e a página
   parou. Causa: conflito entre o conserto do auditor e a regra de forma, resolvido só depois do laço.
2. **Solteirão ou viúva, 2 reescritas (NOT_PUBLISHABLE por coerência).** Juiz: 4 de 4 nas duas. Coerência: a
   medida (100 × 200) e o peso (120 kg) de UM modelo da Probel apareciam como "o solteirão mede/suporta". O redator
   recebia ~150 evidências sem saber qual era ficha de produto e qual era guia ou norma, e a correção automática,
   feita depois sem as evidências à mão, não fechava.
3. **Travesseiro para quem dorme de lado (NOT_PUBLISHABLE por coerência).** Juiz 4 de 4. Coerência: "látex natural é
   indicado para dormir de lado", com o trecho só descrevendo o material. Mesma causa de 2.
4. **Colchão misto ou de espuma (rascunho; corrigido à mão em 26/10).** A resposta curta comparava espuma com
   molas em vez de misto com espuma; a revisão não percebeu (o juiz não lê a dúvida do título contra a resposta).

## O que mudou no motor (commit deste dia)

- **Forma sem IA em toda rodada** (`page.ts`): a resposta curta que abre com atribuição é reordenada antes do
  gate, e a "versão sustentável" do auditor já chega na forma do site. Nenhuma rodada se perde por isso.
- **Alcance da evidência** (`write.ts`, `claimScope`): cada evidência vai ao redator com "SÓ O PRODUTO deste
  documento", "posição da marca" ou "regra geral", e a regra 4d diz como escrever cada uma.
- **Coerência dentro do laço** (`page.ts`, `fixCoherence`): roda antes da revisão; o que ela apontar vira remendo
  nos blocos apontados (redator com todas as evidências), auditado e conferido de novo, uma vez. O corte de
  enchimento, quando remove blocos, dispara uma conferência extra.
- **Causa no passo do ciclo** (`review.ts`, `failureCause`): `page: NOT_PUBLISHABLE (coerência: …)` ou
  `(revisão: …)` ou `(regra: …)`, para medir a aprovação de primeira por causa sem abrir cada run.

## Validação nas duas pautas que falharam em 26/10 (motor novo, dados do ramo do ciclo das 22h)

| Pauta | Ontem | Hoje, motor novo |
|---|---|---|
| Colchão D45 é muito duro | SAFE_STOP após 52 créditos | **PASS** em 4 rodadas, 14,9 créditos; coerência achou 1 problema, o remendo resolveu (coherence-fix-1 kept) |
| Solteirão ou viúva | NOT_PUBLISHABLE (coerência) 2 vezes | **PASS** em 3 rodadas, 10,2 créditos; coerência limpa |

**Quinta causa, achada na validação (commit 63d9433):** a seleção de evidências para o redator (60 de 112) descartava o
guia "Medidas de colchão" da Castor, o único que explica os tamanhos, enquanto entravam dezenas de fichas iguais
("viúva X mede 128 × 188") e garantias; e o alcance deduzido pelo tipo chamava esse guia de "SÓ O PRODUTO".
Correções: alcance (`scope`: produto | marca | geral) decidido na extração, backfill nas evidências antigas por decisão
tipada barata, seleção com revezamento por pergunta, no máximo 2 fichas com os mesmos números por fabricante,
guia/norma pontuando mais, e as evidências das regras de decisão sempre dentro.

**Sexta causa, achada na 3ª reescrita do solteirão (commit 268e06f):** o prompt do redator mandava preencher célula
sem evidência com "não informado nas fontes" e o gate recusa exatamente isso. O redator devolveu 3 vezes a coluna
"Para quem serve" vazia, 2 rodadas pararam no gate sem o auditor ler a tabela, e a página não convergiu (9,1 créditos).
Correções: a coluna (e a linha) sem dado sai por código em toda rodada; o prompt diz que coluna sem evidência não entra.
Regra que fica: **toda regra do gate tem de estar dita no prompt do redator com as mesmas palavras**, e o que o código
sabe consertar ele conserta antes de gastar rodada.

## Sistema para aprovação de primeira (o desenho que estes passos começam)

1. **Decidir antes de escrever.** A checagem de prontidão já extrai as regras "Se você…" com as evidências; cada
   regra deve nascer com o alcance certo (produto, marca, norma). O redator escreve a partir delas, não do monte.
2. **Cada checagem no ponto mais barato.** Forma: código, em toda rodada. Evidência: auditor por bloco, com cache.
   Coerência: antes da revisão, com remendo. Utilidade: juiz por maioria. Nada que o código decide vai ao modelo.
3. **Conserto com contexto.** Toda correção automática acontece onde o redator tem as evidências e os blocos
   trancados; correção "depois do fato" fica só para o editor.
4. **Medir por causa.** O passo do ciclo diz a causa; a meta é aprovação de primeira ≥ 70% (ROADMAP) antes de
   abrir o segundo nicho. Próximas causas a atacar, pela contagem: revisão de leitor (8) e "regra" (3).
5. **Lacunas que são lista de desejos.** O "missing" do juiz vira lacuna da pauta e dispara buscas semanais que
   nunca fecham ("tabela de fabricantes relacionando largura do ombro…"). A conferir: só virar lacuna o que uma
   fonte primária poderia responder.
