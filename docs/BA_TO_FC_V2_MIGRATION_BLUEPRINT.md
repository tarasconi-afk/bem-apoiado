# BA_TO_FC_V2_MIGRATION_BLUEPRINT

Blueprint de transferência da operação editorial do **Bem Apoiado (BA)** para o **Ferramenta Clara V2 (FC V2)**.
Fonte: código do repositório BA em `main` de 24/10/2026, registros de execução em `data/runs/` e o estado da VPS.
Caminhos relativos à raiz do repositório BA. Nenhum segredo, chave ou cookie aparece aqui.

**Convenção de evidência:**
- **[comprovado]** = há execução registrada ou medição;
- **[implementado]** = código em produção sem medição de efeito;
- **[novo]** = em produção há menos de 48 h;
- **[planejado]** = não existe no código.

**Resultado: `BA_TO_FC_V2_BLUEPRINT = READY`** (documentação completa do estado atual). Limitações na seção 8.

---

## 0. Arquitetura em uma tela

```
                 GitHub (main = fonte da verdade: código + data/)
                   │  push no main ──► GitHub Action deploy.yml ──► ramo deploy ──► Hostinger (site estático)
                   │  push em pagina/* ──► Action pr-motor.yml (testes, typecheck, build) [PR opcional]
                   ▲
   VPS (systemd)   │ git pull/push com chave de deploy
   ├─ bem-apoiado-cycle.timer  04/10/16/22h ──► scripts/cycle.sh ──► engine autopilot (runCycle)
   ├─ bem-apoiado-sync.timer   a cada 5 min ──► scripts/painel-acao.sh sync (alinha, prévias, auto_learning, aviso IndexNow/GSC)
   ├─ bem-apoiado-admin        painel HTTP 127.0.0.1:8787 (atrás do Caddy, basic auth + senha própria)
   └─ bem-apoiado-hits         contador de visitas/cliques sem cookie 127.0.0.1:8788 (t.bemapoiado.com/c)
   Estado operacional fora do git: /var/lib/bem-apoiado/ (contadores, filas do painel, cache, adiamentos, chaves)
```

**Três ideias que sustentam tudo:**
1. **O LLM é função JSON→JSON validada por Zod** (`packages/engine/src/llm.ts:callJson`). Ele nunca escreve arquivo, nunca roda git e nunca publica.
2. **Todo resultado do motor que muda o site vira um ramo `pagina/<slug>-<AAAAMMDD-HHMM>`.** O editor decide no **Quadro de decisões**. O que é só aprendizado (fontes, evidências, lacunas) entra sozinho no `main`.
3. **Gate determinístico de evidência** (`packages/core/src/integrity.ts:checkPage`), rodado no build. Página com afirmação sem trecho literal não compila e, portanto, não vai ao ar.

---

## 1. Painel administrativo

**Onde fica:**
- servidor HTTP próprio, sem framework: `packages/engine/src/admin.ts`;
- página HTML renderizada no servidor: `adminPage()` → `renderStatus()` em `status.ts`, com `adminHtml()`;
- JavaScript mínimo inline (`TABS_JS`): áreas, busca e filtros das tabelas.

**Como as ações rodam:**
- tudo que muda dados é um **job** (`startJob`), executado por `scripts/painel-acao.sh <ação> …`;
- os jobs rodam em fila, com a mesma trava do ciclo, e ficam em `/var/lib/bem-apoiado/painel-jobs.json`, com a saída gravada;
- cada ação que muda o site termina em commit (`publish` direto no `main`, ou `merge_branch` depois do gate completo).

### 1.1 Rotas

| Método | Rota | O que faz |
|---|---|---|
| GET | `/` | página do painel (todas as áreas) |
| GET | `/estado` | JSON leve para atualizar a página quando algo muda (versão, job em andamento) |
| GET | `/previa/<ramo>/<caminho>` | prévia estática do site montada a partir do ramo (`/var/lib/bem-apoiado/previas/<ramo>/`) |
| GET | `/imagem?ramo=&arquivo=` | imagem gerada dentro de um ramo pendente (miniatura no card) |
| GET | `/editar/<slug>` | edição manual por bloco (vai para o auditor antes de gravar) |
| POST | `/acao` | todas as ações; checagem de `Origin` contra CSRF; formulário → `toJob()` → job |

### 1.2 Ações (`acao` no POST → caso em `painel-acao.sh`)

| Ação | Efeito | Gate |
|---|---|---|
| `mesclar` | aplica um resultado (ramo); itens desmarcados são desfeitos (`changes-exclude`) | testes + typecheck + build antes do `main` |
| `descartar` | página nova: apaga o ramo. Ajuste de página no ar: desfaz só o que o leitor veria e **guarda o aprendizado** | — |
| `veredito` (approve/reject + motivo) | publica ou recusa um rascunho; o motivo vira instrução e calibração | validate |
| `ajustar` (pedido em texto, opção "pode pesquisar") | corrige uma página (no ramo do resultado ou num ramo novo, se estiver no ar) | auditoria + guarda de regressão |
| `pedido` | "Pedir ao motor": texto livre → ações (pautas, ajuste, capa, produtos, tipo de produto, relatório) | depende da ação |
| `editar` | edição manual por bloco | auditor |
| `fila-adicionar` / `fila-remover` | fila de pautas | validate |
| `produto-ler` / `produto-adicionar` / `produto-reconferir` / `produto-remover` | catálogo de exemplos à venda | `checkProduct` |
| `dominio-aprovar` / `dominio-bloquear` / `dominio-desfazer` | cadastro de fontes | sufixo público recusado; regulador só `.gov.br` |
| `licao-remover` | tira uma lição do redator | — |

### 1.3 Telas (áreas da barra lateral)

| Área | Conteúdo | Funções em `admin.ts` |
|---|---|---|
| Topo (todas) | 4 números: páginas no ar com a meta; "pedem você" com o detalhe por sugestão; créditos do dia contra o teto; cliques na Amazon em 7 dias. Faixa do ciclo ao vivo ou do último ciclo | `kpisHtml` e `cycleLiveHtml` (`status.ts`) |
| **Decisões** | **Quadro de decisões**: um card por resultado, em uma linha (sugestão, título, nota, botão da sugestão), com o detalhe ao clicar | `boardHtml`, `classifyBranch`/`classifyDraft` (`board.ts`) |
| Decisões | Histórico do "Pedir ao motor"; lições do redator (removíveis); pedidos anotados para o desenvolvedor | `requestsHtml` |
| **Páginas** | Tabela das páginas no ar, mais fraca primeiro: nota em barras, visitas, cliques na Amazon, impressões e posição no Google, data. Filtros e ações por linha (ajustar, editar, buscar produtos, capa nova, despublicar) | `livePagesHtml` |
| **Produtos** | Catálogo: origem (editor ou motor), validade, cliques por produto, filtros; "Ler anúncio" pelo link | `productsHtml`, `addProductHtml` |
| **Conteúdo** | Fila de pautas com estado; ideias do autocompletar; domínios novos e decisões do motor sobre domínios | `queueStatus`, `ideasHtml`, `domainsHtml` |
| **Desempenho** | Modo sombra; Search Console; visitas; qualidade do motor; créditos | `shadowHtml`, `gscHtml`, `announceHtml`, `status.ts` |
| **Motor** | Piloto automático, com o botão "Rodar um ciclo agora"; números do motor; detalhe técnico de cada resultado | `pendingHtml` |
| **Configurações** | Saldo de créditos informado; senha | — |
| Rodapé fixo | "Pedir ao motor" em todas as áreas, com a última resposta à vista | `dockHtml` |

### 1.4 O card do quadro (o contrato mais importante para transferir)

`board.ts:classifyBranch` lê o que o ramo muda (`changes.ts:gitChanges` → `describeChanges`) e a revisão de leitor, e devolve:

```ts
interface CardInfo { kind: 'pagina-nova'|'ajuste-no-ar'|'manutencao'|'pauta-tentada'|'rascunho';
  situation: string; suggestion: 'publicar'|'aplicar'|'aprovar'|'corrigir'|'recusar'|'nada';
  why: string;          // as 4 perguntas do editor: decide / leva à compra / leigo / resposta rápida
  correction: string }  // texto pronto para "Pedir correção" (vazio = nada a sugerir)
```

**Regras de apresentação** (decisões do editor em 23 e 24/10):
- **Uma linha por card:** sugestão, título da página do próprio ramo, hora do ciclo tirada do nome do ramo, nota, botão.
- **Botão na linha só quando a sugestão é publicar ou aplicar.** Com "corrigir", a ação "assim mesmo" fica dentro do card.
- **Legenda em cada imagem:** "capa desta página", "capa de outra página: X" ou "foto de exemplo".
- **"Texto pronto" só aparece quando há texto.**
- **O mais urgente vem aberto,** e o resto fica em ordem de urgência (`SUGGESTION_ORDER`).
- **Itens visuais (imagem, produto) têm caixa "aceitar".** O resto entra junto.

---

## 2. Fluxo completo de uma página

```
fila (data/queue.json) ──nextQuery──► planTopic ──► reuseEvidence ──► discoverSources ──► research
   ▲  ideias/GSC                     (pauta)       (evidência de     (mapa de páginas +      (trechos literais
   │                                                pautas vizinhas)  buscas; triagem)         + triagem)
   │                                                                                             │
   │        adiada 3 dias ◄── NOT_READY ◄── readyOrResearch (≥2 regras "Se você…" de fonte de comprador)
   │                                                                                             │ READY
   │                                                         buildPage: redação ⇄ auditoria (até 4 voltas)
   │                                                         + adoção do fix do auditor, atribuição por código,
   │                                                         verdict-from-rules, salvage, ou SAFE_STOP
   │                                                                                             │
   │                       reviewPage (juiz, maioria de 3) ──► PASS ──► editPage ──► ramo pagina/* ──► Quadro
   │                                     │ NOT_PUBLISHABLE                                   (editor: publicar /
   │                                     └► autoCorrect (1 ajuste, mantido se não piora) ──► ramo     corrigir /
   │                                                                                                   descartar)
   │   SAFE_STOP: lacuna registrada; nova tentativa por improveTopic (até 2)                            │
   └───────────────────────────────────────────────────────────────────── mesclar ──► main ──► deploy ──► site
                                                                                         │
                         manutenção a cada ciclo: produtos, imagens, reauditoria, lacuna→fonte,
                         enriquecimento, GSC, ideias, links, resumo fraco, repetições, domínios
```

| Etapa | Código | Entrada → saída | Erros e limites | Próximo passo |
|---|---|---|---|---|
| Seleção | `autopilot.ts:nextQuery` | fila → consulta | pula: no ar, pendente no quadro, esgotada (`improve_attempts ≥ 2`), sem 2 fabricantes (`lacksMakers`), adiada (`isDeferred`), falha de planejamento ≥ 2 | planejar |
| Planejamento | `stages/plan.ts:planTopic` | consulta → `TopicBrief` (perguntas, tipos, `listing_terms`, notas) | 1ª pergunta = o dado que decide; pauta "A ou B" pede uma pergunta por opção | reuso |
| Reuso | `stages/reuse.ts:reuseEvidence` | pauta → evidências de pautas vizinhas ligadas às perguntas | ids inventados descartados; máx. 150 candidatas | descoberta |
| Descoberta | `stages/discover.ts:discoverSources` | pauta → fontes (snapshot com hash) | mapa de páginas do fabricante primeiro (`sitemap.ts`); Tavily, com Brave de reserva; domínio fora do cadastro vira sugestão | pesquisa |
| Pesquisa | `stages/research.ts:research` | fontes → `Claim` (trecho literal) | triagem barata por trecho; cota esgotada = parada limpa | checagem |
| Checagem antes de escrever | `stages/readiness.ts` + `autopilot.ts:readyOrResearch` | evidências → ≥ 2 regras de escolha de fonte de comprador | 1 busca dirigida; senão adia 3 dias **sem gastar redação** | redação |
| Redação e auditoria | `stages/page.ts:buildPage`, `stages/audit.ts:auditDraft` | evidências → `PageSpec` | até 4 voltas; maioria só nos blocos reprovados; regras de forma e de decisão; SAFE_STOP | juiz |
| Juiz | `stages/review.ts:reviewPage` | página → nota 0–4 + `publishable` + `missing` + `reader_problems` | maioria de 3 | quadro / correção automática |
| Correção automática | `autopilot.ts:autoCorrect` | rascunho fraco → 1 ajuste | mantém só se a nota não piora | quadro |
| Revisão humana | quadro (`admin.ts`) | card → decisão | — | mesclar / corrigir / descartar |
| Publicação | `painel-acao.sh:merge_branch` → `deploy.yml` | ramo → `main` → site | testes + typecheck + build antes; site em 2–5 min | aviso aos buscadores |
| Monitoramento | sync + manutenção | site → avisos, reauditoria, produtos | ver seção 4 | atualização |
| Atualização | `maintainAudit`, `maintainEnrich`, `maintainGapSources`, `maintainSummary` | página no ar → resultado novo no quadro | cadência própria (7 a 30 dias) | quadro |

**Estados de página e resultado:**

```
PageSpec.status: draft ──veredito approve──► approved ──veredito reject (despublicar)──► draft
Resultado (ramo pagina/*): pendente ──mesclar──► no main (ramo apagado)
                                   ──descartar─► apagado (aprendizado guardado se era ajuste de página no ar)
                                   ──só aprendizado──► auto_learning mescla sozinho em ~1 min
Pauta na fila (queueStatus): próxima | na fila | esperando você | no ar | rascunho | esgotada
                             | faltam fabricantes | adiada (falta fonte) | falhou no planejamento
Ciclo (cycle-live.json): rodando → ok | falhou ; resultado PAGE_APPROVED | PAGE_DRAFT | STOPPED | MAINTENANCE | NOTHING_TO_DO | DAILY_CAP
```

---

## 3. Autonomia e aprendizado

| Mecanismo | Onde | Estado |
|---|---|---|
| Atribuição de regra de fabricante por código (", segundo a X") | `structure.ts:attributeSingleSource` | **[comprovado]** reprovados 12→8, 7→4, 4→2 nas simulações |
| Auditoria por maioria só nos blocos reprovados | `audit.ts` (`AUDIT_MAJORITY`) | **[comprovado]** oscilação medida de 15% motivou a mudança |
| Juiz por maioria de 3 | `review.ts:majority` | **[comprovado]** concordância com o editor de 6 em 8 vereditos (juiz atual) |
| Checagem antes de escrever | `readiness.ts` | **[comprovado]** 3 de 13 pautas adiadas sem gastar redação |
| Correção automática com guarda de regressão | `autopilot.ts:autoCorrect`, `requests.ts:adjustWithResearch` | **[comprovado]** pillow top de 1,5 para 4; uma versão pior revertida em 24/10 |
| Lacuna → busca semanal → enriquecimento | `requests.ts:recordGaps`, `autopilot.ts:maintainGapSources`, `maintainEnrich` | **[comprovado, 1 caso]** cadeira gamer de 1,5 para 4 em ~1 h (23/10) |
| Releitura de fontes já lidas para pergunta nova | `research.ts:sourcesWorthRereading` | **[comprovado, 1 caso]** trouxe a medida do solteirão (24/10) |
| Lições gerais do editor no prompt do redator | `editor-lessons.ts:learnFromEditor`, `editorLessonsPrompt` (15 lições) | **[implementado]** efeito não medido |
| Erros mais comuns do auditor no prompt | `lessons.ts:writerLessons` | **[implementado]** |
| Rendimento por domínio e URLs improdutivas | `learning.ts:computeLearning`, `plannerHints` | **[implementado]** |
| Regras de decisão (opção do título com dado, tabela de 1 linha, condição repetida, "padrão" de ficha) | `page.ts:decisionIssues` | **[novo]** pegou 3 problemas reais no solteirão e bloqueou uma reescrita repetida |
| Célula de enchimento repetida | `page.ts:styleIssues` | **[novo]** |
| Número no título ou na descrição sem estar no texto | `core/integrity.ts:checkPage` (`META_NUMBER_UNSUPPORTED`) | **[novo]** pegou "solteirão 100 × 200" sem fonte |
| Ajuste que remove bloco ou coluna de tabela | `structure.ts:applyRemovals`, `dropTableColumns` | **[novo]** |
| Domínios avaliados pelo motor e revogados se não renderem | `stages/domains.ts` | **[novo]** sem histórico |
| Modo sombra (o motor publicaria? × o editor) | `shadow.ts`, `admin.ts:noteShadow` | **[novo]** 12 registros em 24 h |
| Não repetir manutenção de resultado pendente | `autopilot.ts` (`images-made`, `gap-search-attempts`, `links-made` no estado) | **[novo]** corrige 4 capas iguais numa noite |

**Pontual × geral:**
- `learnFromEditor` classifica cada pedido como geral ou só da página, e as lições são removíveis no painel.
- A lacuna de **forma** ("Para o leitor leigo: …") nunca vira busca de fonte.
- **Erro sistemático vira regra de código, não prompt.** Cada regra nova foi testada nas páginas no ar antes de ligar. Duas foram **descartadas** por pegarem páginas boas: a checagem de fonte pelo mapa de páginas e o mínimo de 2 condicionais. O registro está em `docs/DECISIONS.md`.

**Impedir ciclos improdutivos:**
- `MAX_IMPROVE_ATTEMPTS = 2`;
- adiamento de 3 dias;
- busca de lacuna por até 3 semanas;
- `plan-failures` ≥ 2;
- cota de busca esgotada não vira "sem fonte" (`search.ts:httpError`);
- teto por ciclo (60 créditos) e por dia (250).

---

## 4. Monitoramento

| O quê | Onde | Dado real hoje |
|---|---|---|
| Páginas no ar e meta | topo, `kpisHtml` | sim (16 de 20) |
| Esperando decisão | topo + quadro | sim |
| Concordância motor × editor | Desempenho → Modo sombra | sim (desde 23/10) |
| Créditos por dia e por categoria | livro-caixa `credits-ledger.jsonl` (o valor cobrado pelo roteador em cada chamada), `llm-usage.json` | sim |
| Créditos por página aprovada | `lessons.ts:auditStats` | sim, agregado (não separa antes e depois) |
| Ciclo ao vivo, último ciclo e falha | `cycle-live.json`, `cycle-last.log` | sim |
| Site desatualizado em relação ao `main` | `live-site.json` (sync) | sim |
| Visitas e cliques na Amazon por página e por produto | contador próprio `hits/AAAA-MM-DD.jsonl` | sim; 0 cliques dos guias até 24/10 |
| Search Console (impressões, posição, buscas) | `gsc.ts:fetchSnapshot` diário | conectado, **sem dados ainda** (o Google confirmou impressões a partir de 22/10; o painel recebe com 3 dias de atraso) |
| Aviso de página nova (IndexNow + reenvio do sitemap) | `announce.ts` no sync | sim (funcionou em 23/10) |
| Produtos vencidos ou sem oferta | `refresh.ts` no ciclo; validade da escolha do editor (45 dias) | sim |
| Ganhos da Amazon | — | **não integrado** (o relatório da Amazon é lido à mão) |
| Alerta fora do painel (e-mail, mensagem) | — | **[planejado]** |

---

## 5. Imagens

- **Geração:** `images.ts:generateImage`, com o modelo `gpt-image-2` pelo roteador e qualidade média. Os pedidos ficam em `data/images/briefs.json` e o estilo da casa (`HOUSE_STYLE`) vale para todas. Saída em WebP com 1600 px de largura, em `site/src/assets/generated/<id>.webp`.
- **Registro e procedência:** `data/images/registry.json` (43 imagens), com id, tipo, arquivo, texto alternativo, tamanho, modelo, qualidade, prompt, créditos, sha256, data e licença. Na página, as imagens são rotuladas: "Imagens ilustrativas geradas por IA, sem marca".
- **O que é gerado:**
  - ilustração por tipo de produto (cards e grade);
  - capa por página aprovada (`pagina-<slug>`);
  - ilustração por produto (`produto-<asin>`): genérica, com a cor e o material do anúncio, sem marca nem modelo reconhecível.
- **Segurança do conteúdo:** proibido mostrar pessoas, texto, números, logotipos, marcas, embalagens ou produto identificável. É regra do prompt, sem validação automática da imagem. Na auditoria de 24/10, uma capa antiga tinha uma mão.
- **Corte e uso:**
  - a capa aparece em faixa 32:9 no topo (escolha do editor entre 3 opções) e o pedido manda compor o assunto na faixa do meio;
  - a grade de tipos só aparece quando a pergunta compara tipos (`site/src/lib/content.ts:comparesKinds`);
  - a home nunca repete imagem;
  - as imagens são responsivas (avif/webp, várias larguras), com Astro `Picture`.
- **Custo:** cerca de 5 créditos por imagem, até 2 por ciclo, e só com 15 créditos sobrando.
- **Não regenerar:** `wantedImages` gera só o que falta no `main`. Desde 24/10, o estado `images-made.json` também evita repetir o que já está num resultado pendente. **[novo]**

---

## 6. Publicação e segurança

- **Aprovação ≠ publicação:**
  - "Publicar" no card é `mesclar` (o ramo entra no `main`);
  - um rascunho só vai ao ar com `veredito approve`;
  - página `draft` é `noindex` na prévia e não sai no site;
  - o build falha se o gate de evidência falhar.
- **Versionamento:**
  - tudo em git: página, evidência com trecho literal, snapshot da fonte com hash e registro de cada etapa em `data/runs/<run>/`;
  - cada decisão do editor é um commit ("Painel: …").
- **Revisão antes de publicar:** prévia por ramo (`/painel/previa/<ramo>/`) e o antes × depois de cada trecho e de cada ajuste.
- **Publicação acidental:**
  - código nunca vem de ramo `pagina/*` (só `data/`);
  - conflito em `data/` aborta;
  - os 3 gates rodam no `main` antes do push.
- **Deploy:**
  - push no `main`, depois a Action `deploy.yml`, depois o ramo `deploy`, depois a Hostinger;
  - plano B manual em `scripts/deploy-hostinger.sh`.
- **Desfazer:**
  - `veredito reject` despublica;
  - "Descartar" apaga o resultado pendente;
  - no git, um `revert` do commit "Painel: mescla…". Não há botão de reverter no painel.
- **Credenciais:**
  - `/etc/bem-apoiado/env` (640), `gsc-key.json` (600) e a senha do painel (hash scrypt);
  - nunca no git;
  - os testes nunca carregam chaves reais (`env.ts` ignora o arquivo quando `VITEST` está definido).
- **Limites de gasto:**
  - por ciclo: `BEM_CYCLE_BUDGET = 60`;
  - por dia: `BEM_DAILY_CREDIT_CAP = 250`, e o ciclo manual não conta até 20 páginas;
  - Tavily: 1.400 buscas por mês;
  - Brave: 900 por mês, para ficar no crédito grátis;
  - página nova só com 15 créditos sobrando.
- **Falha de etapa:**
  - erro do modelo (saída inválida 2 vezes) vira falha registrada, e a pauta sai da vez depois de 2 falhas;
  - a rede caindo no meio faz o ciclo falhar sem gravar nada, porque o resultado só é gravado no fim;
  - uma ação do painel que falha fica como "falhou" e pode ser refeita;
  - desligamentos forçados em 23/10 (5 no datacenter) não corromperam nada (git fsck, JSONs e livro-caixa conferidos).

---

## 7. Portabilidade para o FC V2

O FC V2 já tem:
- motor TypeScript com redator e auditor;
- gate pré-redação de adequação (`core/adequacy*.ts`);
- registro de auditoria com hash por unidade (`refine.ts:buildLedger`);
- trilha de revisão humana com hash (`data/reviews/<slug>.jsonl`), com aprovar, precisa melhorar e recusar;
- Admin local em `127.0.0.1:8790`;
- prontidão editorial (`editorial.ts`);
- tetos por página.

| Mecanismo do BA | Classe | Observação |
|---|---|---|
| Gate de evidência literal (`checkPage`, `checkClaim`) | A | o FC já tem `validate`. Acrescente `META_NUMBER_UNSUPPORTED` (título e descrição) |
| Regras de decisão e de forma por código (`decisionIssues`, `styleIssues`) | A | funções puras sobre a página. Adapte aos `page_type` do FC |
| Atribuição por código, `decisionLast`, `applyMoves`, `applyRemovals`, `dropTableColumns` | A | funções puras (`structure.ts`) |
| Modo sombra (`shadow.ts`) | A | arquivo JSONL e 3 funções. No FC, gravar a cada decisão na trilha de revisão |
| Juiz por maioria e as 4 perguntas (`review.ts`) | B | o FC tem `readerUtility` determinístico; o juiz LLM é opcional |
| Auditoria por maioria só nos reprovados | B | o FC já tem `majorityAudit` em unidades contestadas |
| Checagem antes de escrever (`readiness.ts`) | B | o FC tem `preWritingAdequacy`; manter o dele |
| Quadro de decisões (`board.ts` + card) | B | o mais valioso para transferir. No FC, o card lê a proposta e a auditoria em vez de um ramo git |
| Ajuste por pedido em texto com guarda de regressão (`adjustWithResearch`) | B | depende do redator e do auditor do FC |
| Lacuna → busca semanal → enriquecimento | B | precisa de pesquisa automática no FC |
| Lições do editor (`editor-lessons.ts`) | B | o FC tem `data/learning/lessons.json`, que nenhum prompt lê: ligar ao prompt do redator |
| Mapa de páginas do fabricante (`sitemap.ts`) | A | sem dependência; reduz busca paga |
| Releitura dirigida de fontes já lidas | B | depende do extrator do FC |
| Domínios avaliados pelo motor (`domains.ts`) | B | depende do cadastro de fontes do FC |
| Painel em abas, tabelas com filtro, rodapé "Pedir ao motor" | B | HTML no servidor + JS mínimo. Reaproveite o layout, não o arquivo de 1.200 linhas |
| Ramos `pagina/*` + `painel-acao.sh` + `auto_learning` | C | git como banco de dados e fila. No FC (local), um estado de proposta em arquivo basta |
| systemd, Caddy, prévia por ramo, sync de 5 min | C | só se o FC tiver VPS |
| Contador de visitas próprio | C | depende de endpoint público |
| IndexNow + reenvio do sitemap | A | `announce.ts` só precisa de fetch e da chave do GSC |
| Créditos do roteador Hostinger, Tavily e Brave | C | trocar pelos provedores do FC |
| Escalada para redator caro | D | desligada no BA desde 21/10, sem ganho medido |
| Checagem de fonte pelo mapa de páginas antes da fila | D | testada e descartada (bloquearia 6 pautas aprovadas) |

---

## 8. O que realmente funciona (evidências)

- **Produção:** 16 páginas no ar e 3 prontas no quadro em 24/10. Em 22 e 23/10 foram de 3 a 5 aprovadas por dia; na noite de 23 para 24/10, 3 ciclos seguidos aprovaram páginas novas (PASS do juiz).
- **Participação humana, que continua sendo o gargalo:**
  - nas páginas no ar até 23/10, 12 de 13 tiveram ajuste do editor;
  - no modo sombra, as 3 páginas novas de 24/10 tiveram **"o motor publicaria, o editor corrigiu"**: o juiz deu 4 de 4, e a revisão humana achou um produto apresentado como solução sem a fonte dizer isso (dupla face para casal), uma medida de produto virando regra de tamanho (queen e king) e um "Como decidir" raso.

  **Conclusão: o juiz por bloco e por pergunta não enxerga coerência da página inteira.**
- **Custo:**
  - créditos por dia: 252 (21/10), 223, 134, 97 (24/10, até as 10 h);
  - cerca de 20 a 30 créditos por ciclo com página aprovada;
  - um desperdício medido em 24/10 (capa repetida 4 vezes, cerca de 15 créditos), já corrigido.
- **Recuperação que funcionou:** pillow top (1,5→4), cadeira gamer (1,5→4, por lacuna→fonte), solteirão (1,5→2,5, por releitura), casal (correção do editor mantendo 4 de 4).
- **Falhas recorrentes:** pautas sem fonte decisória (cadeira para obeso: 3 tentativas, cerca de 50 créditos, cortada pelo limite); variação do redator; tabela com dado de um produto tratado como regra.
- **Sem efeito medido:** lições no prompt, rendimento por domínio, domínios avaliados pelo motor, modo sombra (poucos dados), mapa de páginas (economia não medida).

---

## 9. Blueprint de implementação no FC V2 (menor sequência)

**Fase 1: estados editoriais e quadro**, o maior ganho.
1. **Um "resultado" por proposta**, com estado `pendente → aceito | corrigir | descartado`, gravado na trilha de revisão que já existe. Sem aprovação paralela.
2. **Um card por resultado,** com o contrato `CardInfo` (seção 1.4): sugestão do motor (a partir de validate, prontidão editorial e auditoria), por quê nas 4 perguntas, antes × depois, prévia local e texto pronto de correção.
3. **Modo sombra desde o primeiro dia:** cada decisão grava a sugestão do motor e a ação humana.

**Fase 2: correção com aprendizado.**
1. **"Pedir correção" em texto** → ajuste por bloco, com auditoria e guarda de regressão (o FC já tem `regressionGuard`).
2. **Ajuste sem IA** para mover, tirar bloco e tirar coluna (funções puras do BA).
3. **Lições:** ligar `data/learning/lessons.json` ao prompt do redator; o que falta por fonte vira lacuna; descartar guarda o aprendizado.
4. **Regras de decisão do BA por código,** rodando na redação e no ajuste, e não na reauditoria de página antiga.

**Fase 3: monitoramento e custos.**
1. Livro-caixa por chamada (o FC já mede o custo real por saída do Haiku). Teto por página e por dia, mostrados no topo do painel.
2. Tabela de páginas, mais fraca primeiro, e a tabela de produtos e ofertas.
3. IndexNow + reenvio do sitemap no momento da publicação (`announce.ts` portável).

**Fase 4: migração segura das páginas antigas do FC.**
1. **Importar cada página antiga como rascunho,** passando por validate e prontidão editorial. Nada sai do ar automaticamente.
2. **Relatório por página:** o que falta (evidência, adequação). A página antiga continua no ar até a nova ser aceita no quadro, e a troca é uma decisão por card.
3. **Republicar** com redirecionamento só se a URL mudar.

**Fase 5: produção recorrente.**
1. Ciclo agendado, uma página por vez, com o gate pré-redação do FC antes de qualquer chamada paga.
2. **Antes de escalar para 50 ou mais páginas:** uma **auditoria de coerência da página inteira**, que é a lacuna medida no BA em 24/10. Ela pergunta, com lista fechada:
   - algum produto aparece como solução que a fonte não diz resolver?
   - alguma medida de produto virou regra?
   - cada caso da resposta curta tem orientação?
3. **Publicação automática só quando o modo sombra cumprir o critério:** nas últimas 10 decisões, 9 ou mais concordam, nenhuma publicaria errado, e elas cobrem 14 dias ou mais. Sempre com autorização explícita do dono.

**Não replicar:**
- git como fila de resultados;
- prévia por ramo;
- systemd e sync, se o FC continuar local;
- a escalada de redator;
- a checagem de fonte pelo mapa de páginas antes da fila.
