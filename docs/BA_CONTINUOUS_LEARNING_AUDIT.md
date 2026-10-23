# BA_CONTINUOUS_LEARNING_AUDIT

Auditoria do sistema de aprendizado contínuo do Bem Apoiado, para avaliar a transferência ao Ferramenta Clara.
Estado do código: `main` de 23/10/2026. Caminhos relativos a `packages/engine/src/`, salvo indicação.
Convenção: **[comprovado]** = há registro de execução ou medição; **[existe]** = código em produção sem medição de
efeito; **[novo]** = entrou em 23/10 e ainda não tem histórico.

---

## 1. Arquitetura realmente implementada

- **Linguagem e validação:** TypeScript (Node 22), com schemas Zod em `packages/core/src/schemas.ts`.
- **O LLM** é sempre função JSON→JSON validada por código: `llm.ts:callJson`. Ele nunca executa shell, git ou deploy.
- **Estado do conteúdo:** fica em `data/`, versionado no git. São fontes com snapshot e hash, evidências (claims com
  trecho literal), pautas, páginas e o registro de cada execução por etapa (`data/runs/<run_id>/<etapa>.json`).
  Hoje há 81 execuções registradas.
- **Estado operacional** (contadores, adiamentos, cache, chaves): fica fora do git, em `/var/lib/bem-apoiado/`.
- **Gate determinístico:** `packages/core/src/integrity.ts` (`checkPage`, `checkClaim`, `checkProduct`). Toda frase
  aponta para um `claim_id` de lista fechada, e o trecho tem de existir literalmente no snapshot. `npm run build`
  roda o gate, e violação derruba o build e o deploy.
- **Ciclo:** `stages/autopilot.ts:runCycle`, 4 vezes por dia via systemd, mais o botão do painel. Primeiro a
  manutenção (10 tarefas com cadência própria), depois no máximo uma pauta.
- **Publicação:** resultado que muda o site vai para um ramo `pagina/*`, o painel mostra um card e o editor aceita
  (`scripts/painel-acao.sh:merge_branch`, que roda testes, typecheck e build antes do `main`). Resultado que é só
  aprendizado é mesclado sozinho (`auto_learning`). Push no `main` → GitHub Action → Hostinger.

Fluxo de uma pauta nova (`runCycle`):
```
planTopic (plan.ts) → reuseEvidence (reuse.ts) → discoverSources (discover.ts) → research (research.ts)
→ readyOrResearch (autopilot.ts + readiness.ts) → buildPage (page.ts: write ⇄ auditDraft, até 4 rodadas)
→ reviewPage (review.ts) → [NOT_PUBLISHABLE] autoCorrect (autopilot.ts → requests.ts:adjustWithResearch)
```

## 2. Como cada falha é identificada e classificada

| Falha | Onde é detectada | Classificação |
|---|---|---|
| Pesquisa sem fonte | `discover.ts:discoverSources` (`report.queries`, `triage`, `snapshot_errors`, `suggestions`) | busca vazia, domínio fora do cadastro (vira sugestão), domínio bloqueado, página já improdutiva |
| Evidência que não responde | `research.ts:research` (`accepted`, `unanswered`) | pergunta da pauta sem trecho |
| Fonte não diz o que escolher | `readiness.ts:decisionReadiness` + `buyerRules` | precisa de 2 ou mais regras "Se você…" de fonte de comprador (fabricante, teste independente, norma), sem linguagem de posto de trabalho; senão NOT_READY |
| Afirmação sem sustentação | `stages/audit.ts:auditDraft` | por bloco: SUPPORTED, OVERSTATED, UNSUPPORTED, MISATTRIBUTED, FACT_IN_FRAMING, SAFETY_CLAIM |
| Forma e estilo | `page.ts:styleIssues` | regras de código: resposta curta, célula de tabela sem número, atribuição faltando… |
| Página fraca para o leitor | `review.ts:reviewPage` (juiz por maioria de 3) | 4 perguntas do editor → `readerScore` de 0 a 4; `missing` e `reader_problems` em texto |
| Integridade | `core/integrity.ts` | códigos fixos (`PRODUCT_PROMO_LABEL`, `BASIS_REQUIRES_CLAIMS`…) |
| Publicação | `painel-acao.sh:merge_branch`, `live_check` | testes, typecheck ou build falharam; site em versão antiga |
| Cota de busca | `search.ts:httpError` | 432/433 da Tavily = teto, não "busca vazia" **[novo]** |
| SEO | `gsc.ts:opportunities` | quase na 1ª página, CTR baixo, busca sem página **[existe, sem dados do Google ainda]** |

## 3. Como a falha vira aprendizado persistente

| Aprendizado | Onde fica | Quem grava | Quem lê |
|---|---|---|---|
| Rendimento por domínio, URLs improdutivas, lacunas recorrentes | calculado de `data/` a cada uso | `learning.ts:computeLearning` | `plannerHints` → prompt do planejador de buscas; ranking em `discoverSources` (`yieldOf`, `unproductiveUrls`) |
| Erros mais comuns do auditor | calculado dos `audit-r*.json` | `lessons.ts:auditStats` | `lessons.ts:writerLessons` → prompt do redator (4 tipos mais frequentes, com exemplo real) |
| Regra geral do editor | `data/editor-lessons.json` (6 regras hoje) | `editor-lessons.ts:learnFromEditor` (LLM decide se é geral) | `editorLessonsPrompt` → redator e planejador de buscas |
| Veredito do editor | `data/feedback/` | `feedback.ts:recordVerdict` | `calibrate` + `applyCalibration` → limites do juiz (`data/calibration.json`) |
| Exemplos aprovados | páginas aprovadas pelo editor | — | `exemplars.ts:examplesPrompt`, `judgeCalibration` → redator e juiz |
| Lacuna da pauta | `data/topics/<slug>.json` → `evidence_gaps` | `runCycle` (SAFE_STOP), `improveTopic`, `requests.ts:recordGaps` | `discoverSources` ("PRIORIDADE: …"), `improveTopic` |
| Regra de decisão sustentada | `topics/<slug>.json` → `editorial_notes` (prefixo `NOTE_PREFIX`) | `readiness.ts:saveRules` | `page.ts:verdictFromRules`, `board.ts:rulesFromNotes`/`correctionText` |
| Página "falta fonte, não texto" | `data/source-gaps.json` | `requests.ts:recordGaps` | `autopilot.ts:maintainGapSources` (1 vez por semana, até 3 semanas) **[novo]** |
| Pauta sem fonte decisória | `/var/lib/.../deferred-topics.json` | `readyOrResearch` | `isDeferred` (3 dias) |
| Antes × depois de ajuste | `runs/<id>/adjust-diff.json` | `requests.ts:recordAdjust` | painel; avaliação manual |
| Fabricante × tipo de produto | `data/registry/domains.json` → `kinds` | painel, `requests.ts:createKind` | `discover.ts:makersFor`, `autopilot.ts:lacksMakers` |

## 4. Como os aprendizados são aplicados em pautas futuras, inclusive de outro tema

- **Entre temas:**
  - `writerLessons` e `editorLessonsPrompt` entram no prompt de **toda** redação;
  - `plannerHints` entra em **toda** descoberta;
  - `reuse.ts:reuseEvidence` traz evidência já verificada de pautas vizinhas antes da pesquisa nova.
    Exemplo real no log de 23/10: "reuso: 16 evidência(s) já verificadas de 11 fonte(s) de pautas vizinhas".
- **Na mesma pauta:**
  - `evidence_gaps` dirige a próxima descoberta e o `improveTopic`;
  - `editorial_notes` vira a resposta curta montada a partir das regras quando a síntese é recusada (`verdictFromRules`);
  - também vira o texto pronto de correção no painel (`correctionText`).
- **No juiz:** `calibrate` só muda os limites com `MIN_LABELS = 8` vereditos e ganho real de concordância.

## 5. Correção pontual × melhoria geral

- **Pedido do editor:**
  - `learnFromEditor` classifica o pedido em `general` ou não, e `already_covered` evita regras repetidas;
  - o que é específico vai para as notas da pauta, não para todas as páginas;
  - o editor remove regras no painel (`removeEditorLesson`).
- **Achado do juiz:** `recordGaps` só guarda lacuna de **conteúdo**. Lacunas de forma ("Para o leitor leigo: …",
  "resposta curta") ficam de fora, porque são texto e o redator resolve.
- **Erro sistemático:** vira **código**, não prompt. Exemplos:
  - `structure.ts:attributeSingleSource` (atribuição a fabricante);
  - `decisionLast`;
  - as regras de `styleIssues`.

  Regra geral no prompt foi evitada de propósito, porque aumentava a variação.
- **Proteção contra regra restritiva demais:** o painel mostra a concordância do juiz com o editor, e a calibração
  exige 8 vereditos. **Não existe** detecção automática de regra que esteja piorando as páginas.

## 6. Recuperação, retentativas, limites de custo e SAFE_STOP

- **`page.ts:buildPage`:** até 4 rodadas de redação e auditoria. Na auditoria, os blocos reprovados passam por mais
  2 auditorias e vale a maioria (`AUDIT_MAJORITY`).
- **Recuperação dentro da página, em ordem:**
  1. `adoptAuditorFixes`;
  2. `fixFormWithoutAI`;
  3. `verdictFromRules`;
  4. `salvage`;
  5. só então SAFE_STOP.

  A escalada para um redator mais caro (`ESCALATION_WRITER`) está **desligada por padrão desde 21/10**
  (`BEM_ESCALATION=1` religa). Duas escaladas, de 14 e 36,5 créditos, terminaram em rascunho; um ajuste do editor
  custa de 2 a 5 créditos. As 3 páginas no ar com etapa `escalation` são anteriores a isso.
- **Depois da página:**
  - `autoCorrect`: 1 ajuste automático, mantido só se a nota não piorar;
  - `improveTopic`: até `MAX_IMPROVE_ATTEMPTS = 2` novas tentativas dirigidas às lacunas;
  - SAFE_STOP sem lacuna registrada vira lacuna, para a fila não tratar a pauta como esgotada.
- **Guarda de regressão do ajuste** (`requests.ts:adjustWithResearch`): o juiz avalia antes e depois. Se piorou, a
  página volta à versão anterior, e as fontes e evidências novas ficam.
- **Custo:**
  - teto por ciclo (`BEM_CYCLE_BUDGET = 60` créditos) e por dia nos ciclos automáticos (`BEM_DAILY_CREDIT_CAP = 250`);
  - piso para começar página nova (`PAGE_MIN_CREDITS = 15`);
  - Tavily com 1.400 buscas por mês (`search.ts`) e Brave como reserva, com 900 por mês **[novo]**;
  - falha de planejamento 2 vezes tira a pauta da vez.
- **Antes de escrever:** `readyOrResearch` faz uma busca dirigida (`makerSearches: 6`). Se ainda não houver regra de
  escolha, adia a pauta 3 dias **sem gastar redação**.

## 7. Uso de resultados anteriores

- **Seleção de pautas:**
  - `nextQuery` pula pauta no ar, esgotada ou adiada;
  - `lacksMakers` pula pauta sem 2 fabricantes cadastrados para o tipo;
  - `ideas.ts` (autocompletar do Google) e `maintainGsc` alimentam a fila.

  A ordem da fila veio do Keyword Planner, posta à mão.
- **Pesquisa:**
  - rendimento por domínio e URLs improdutivas (`learning.ts`);
  - rodízio de fabricantes (`discover.ts:orderMakers`, `searchedAlone`);
  - mapa de páginas do fabricante antes da busca paga (`sitemap.ts:siteUrls`, `rankUrls`) **[novo]**.
- **Reaproveitamento:** `reuse.ts:reuseEvidence`; snapshot com hash reaproveitado quando o conteúdo não mudou.
- **Prompts:** `writerLessons`, `editorLessonsPrompt`, `examplesPrompt`, `plannerHints`.
- **Auditoria e juiz:** `judgeCalibration` (exemplos aprovados) e `calibrate`. Releitura periódica das páginas no ar
  com `reaudit.ts:nextReaudit` (30 dias, ou quando o auditor muda).

## 8. O que foi usado nas 13 páginas no ar (pelos registros em `data/runs`)

| Mecanismo | Páginas no ar em que aparece |
|---|---|
| Laço redação ⇄ auditoria, revisão de leitor, gate | 13 de 13 |
| Ajuste pedido pelo editor | 12 de 13 ("1 de 13 no ar sem ajuste seu", no painel) |
| `salvage` | 7 · `escalation` 3 · `adopt-fixes` 3 |
| `improveTopic` (nova tentativa por lacuna) | 4 (d28-ou-d33, como-escolher-cadeira, densidades, pillow top) |
| Checagem antes de escrever (`readiness-0.json`) | 3 (densidades, tamanhos, pillow top) |
| `autoCorrect` | 1 (pillow top: nota 1,5 → 4) |
| Auditoria por maioria + atribuição por código | 2 (pillow top, cadeira gamer), as únicas feitas depois de 23/10 de madrugada |
| Lacuna → busca semanal → enriquecimento | 1 (cadeira gamer, 23/10; ver o exemplo real) |
| Mapa de páginas, Brave, IndexNow, tipo de produto pelo painel, filtro de domínios | 0 páginas; em produção desde 23/10 **[novo]** |

## 9. Métricas

**Medidas com o mesmo método, antes e depois** (simulações em cópia isolada, `docs/TESTES-2026-10-23.md`):
- **Aprovação de primeira nas mesmas pautas:** 1 de 5 antes das mudanças. Depois, 6 de 10 pautas com fonte
  aprovadas de primeira, e 8 de 10 com nota 3 ou mais.
- **Pautas sem fonte:** 3 de 13 adiadas pela checagem antes de escrever, sem custo de redação.
- **Repetição:** 2 de 3 pautas aprovadas passaram de novo.
- **Oscilação do auditor:** 9 de 59 blocos (15%) mudavam de veredito no mesmo rascunho. Isso motivou a maioria.
- **Atribuição por código, blocos reprovados:** 12→8, 7→4 e 4→2 em três rascunhos.

**Juiz × editor:** 6 de 8 vereditos com o juiz atual (`data/judge-rescore.json`). A calibração antiga registra 0,5
(`data/calibration.json`, 8 vereditos).

**Agregado de 60 dias** (`lessons.ts:auditStats`; mistura antes e depois das melhorias, não separa por data):
- 45 tentativas, 10 aprovadas (22%);
- 7,8 problemas na 1ª auditoria e 3,7 rodadas por tentativa;
- 16,5 créditos por página aprovada, contando só a geração;
- erros do auditor: OVERSTATED 192, UNSUPPORTED 190, MISATTRIBUTED 115, FACT_IN_FRAMING 29.

**Custo de operação** (painel, 7 dias de implantação): cerca de 716 créditos de IA e cerca de 102 por página aprovada,
contando manutenção e tentativas que falharam; 683 buscas Tavily em outubro.

**Não medido:**
- efeito isolado de `writerLessons`, `editorLessonsPrompt`, `plannerHints` e do rendimento por domínio (não houve teste A/B);
- chamadas evitadas pelo reaproveitamento e pelo mapa de páginas;
- tempo por página;
- o efeito da calibração.

## 10. Exemplo real completo (com reutilização comprovada)

**Pauta:** "Cadeira ergonômica ou gamer: qual escolher" (página no ar).

1. **Erro detectado:** a revisão de leitor deu 1,5 de 4 ("responde em parte", "leigo não", "resposta rápida não").
   Foram 8 ajustes de texto pelo editor, sem ganho. O último, em 23/10 às 09:23, ficou em 0,5 antes e 0,5 depois.
   `reader_problems`: "A resposta não diz quando escolher uma cadeira ergonômica de escritório e quando escolher uma
   gamer".
2. **Causa identificada:** faltava fonte, não texto. A página dependia quase só da Flexform, e nenhuma fonte trazia
   a regra escritório × gamer. O `missing` do juiz pedia "uma regra direta para escolher entre cadeira de
   escritório/ergonômica e gamer…".
3. **Correção aplicada:**
   - `requests.ts:recordGaps` passou a guardar a lacuna sempre que um ajuste não melhora e a página ainda não decide;
   - `autopilot.ts:maintainGapSources` busca fonte para a lacuna;
   - "Descartar ajuste" guarda o aprendizado (`painel-acao.sh descartar` → `merge_branch` com exclusões).
4. **Aprendizado persistido:**
   - `data/topics/cadeira-ergonomica-ou-gamer.json` → `evidence_gaps` (3 lacunas de conteúdo);
   - `data/source-gaps.json` → `{ "cadeira-ergonomica-ou-gamer": { gaps, tries: 0 } }`.
5. **Uso posterior:**
   - **Ciclo de 23/10 às 10:13:** "busca de fonte para a lacuna… 4 fonte(s) nova(s)", depois "enriquecimento…
     +26 evidências, página reescrita e aprovada pela auditoria" (execução `20261023T131539_…-enrich_a79a`).
   - **Revisão de leitor da versão nova:** 4 de 4 (decide, leigo, resposta rápida, leva à compra).
   - **Aplicação:** 10:26, pelo quadro (commit "Painel: mescla pagina/cadeira-para-obeso-qual-escolher-20261023-1019").
   - **Resposta curta nova:** "A escolha entre cadeira de escritório e gamer depende das regulagens que cada modelo
     oferece, não do nome…".
   - **Ressalva:** é **um** caso. A lacuna foi registrada à mão pela primeira vez, pelo mesmo `recordGaps`. Ainda não
     há caso em que o motor tenha registrado e resolvido sozinho, do começo ao fim.

**Exemplo de correção por código, sem aprendizado persistido:** o auditor recusava "Se você pesa mais de 110 kg,
evite bases de nylon" por ser regra de um fabricante sem dizer de quem. A causa medida foi que 8 de 11 recusas
consistentes eram de atribuição. A correção foi `structure.ts:attributeSingleSource`, que acrescenta ", segundo a X".
O uso posterior aparece nas simulações seguintes, com casal e colchão para obeso aprovados 4/4. Não é aprendizado
em dados: é regra de código que vale para todas as páginas.

## 11. Limitações

- **O gargalo continua sendo o editor:** 12 das 13 páginas no ar precisaram de ajuste dele.
- **Variação do redator:** a mesma pauta passa numa rodada e não na outra (solteirão: 4/4 e depois 2,5).
- **Pauta sem fonte decisória** só é descoberta depois da pesquisa. Ainda não há checagem barata antes de pôr na fila.
- **Linha de tabela** com dado de um produto usado como regra geral ainda trava a auditoria (cama box, quando trocar).
- **Métricas agregadas** (`auditStats`) não separam antes e depois, e não existe painel de tendência.
- **A calibração do juiz** tem só 8 vereditos.
- **Sem medição de efeito** dos aprendizados que vão em prompt (lições, dicas do planejador).
- **Aprendizado operacional fora do git** (adiamentos, tentativas) se perde se a VPS for perdida (ver `docs/RECUPERACAO.md`).

## 12. Recomendações de portabilidade para o Ferramenta Clara

**Portável como conceito e código** (TypeScript puro, sem dependência de infraestrutura):
1. Evidência por `claim_id` de lista fechada, mais gate de trecho literal (`core/integrity.ts`). O FC já tem
   PageSpecs e tipos de evidência, então o encaixe é direto.
2. Checagem antes de escrever (`readiness.ts`): só redige com 2 ou mais regras de escolha sustentadas; senão, busca
   dirigida e depois adiamento. É a maior economia medida.
3. Auditoria por maioria só nos blocos reprovados (`stages/audit.ts`) e juiz por maioria de 3 com as 4 perguntas
   (`review.ts`).
4. Correções sistemáticas em código (`structure.ts`, `styleIssues`), não em prompt.
5. Guarda de regressão em todo ajuste, mais `autoCorrect` mantido só se não piorar.
6. Lacuna de conteúdo → `source-gaps` → busca semanal limitada → enriquecimento com aceite humano.
7. Lição geral do editor com classificação geral/pontual por LLM, removível (`editor-lessons.ts`).
8. Rendimento por domínio a partir do histórico (`learning.ts`), mais mapa de páginas do fabricante antes da busca
   paga (`sitemap.ts`).
9. Cota de busca tratada como teto, nunca como "sem resultado" (`search.ts:httpError`), para não criar aprendizado falso.

**Dependente da infraestrutura do Bem Apoiado** (reescrever no FC):
- **Git como banco de dados:** cada resultado num ramo, card com prévia, `painel-acao.sh`, `auto_learning`. No FC
  com n8n e Postgres, isso vira tabela de resultados com estado e um aceite.
- **Operação:** systemd na VPS, prévia por ramo e Caddy.
- **Serviços externos:** créditos do roteador Hostinger, Tavily e Brave, produtos por índice de busca da Amazon,
  conta de serviço do Search Console.

**Ordem sugerida, do maior ganho medido para o menor:**
1. Gate de evidência literal.
2. Checagem antes de escrever.
3. Auditoria e juiz por maioria.
4. Atribuição e estrutura por código.
5. Guarda de regressão com `autoCorrect`.
6. Lacuna → busca semanal.
7. Lições do editor.
8. Mapa de páginas.
