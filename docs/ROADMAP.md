# Roadmap

## Fase 0 — Fundação ✅ (2026-10-20)
Monorepo, schemas, verificador de integridade com testes, snapshot de fontes (HTML e PDF),
site Astro com noindex por padrão, primeira fonte primária real (Portaria Inmetro 386/2013).

## Fase 1 — Primeira página de ponta a ponta ✅ (2026-10-20)
Pauta "colchão de molas ou espuma": 11 fontes, 104 evidências, página PASS (run *_dae4).
- [x] gateway LLM (Hostinger AI Router), streaming, saída validada por Zod, schema no prompt
- [x] research com verificação literal (6% dos trechos propostos eram inventados e foram barrados)
- [x] write com claim_ids em enum fechado; regras editoriais e de saúde
- [x] audit por outro fornecedor, por seção, com cache por conteúdo
- [x] correção por remendos (blocos aprovados ficam trancados), máx. 3 voltas, depois SAFE_STOP
- [ ] PR no GitHub com página + relatório (depende de push liberado na sessão)

Backlog editorial observado na revisão do PM: repetição de aviso terapêutico entre blocos;
rótulo da 1ª coluna da tabela; frases vagas de fabricante sobre durabilidade. Candidato: etapa de
"editor" que só corta/funde blocos já aprovados (nunca acrescenta fato).

## Fase 2 — No ar  ← atual
- [x] design editorial; fontes agrupadas em bloco expansível; página "Como trabalhamos"
- [x] preview no ar: https://srv2079501.hstgr.cloud (Caddy na VPS, noindex em 3 camadas) — `npm run deploy:preview`
- [x] teto de gasto por execução e custo gravado no run
- [x] infraestrutura do catálogo de afiliados: schema Product, gate (ficha do fabricante + anúncio do
      mesmo ASIN com menos de 30 dias + sem nome promocional), seção "Exemplos à venda" com rel=sponsored
- [x] captura via Tavily extract (`snapshot --via tavily`): lê anúncio da Amazon a partir da VPS (bloqueada no acesso direto)
- [x] corte de enchimento antes de reprovar (página "quase lá" passa por nova revisão) e ciclo espera merge de PR pendente
- [x] etapa `products` (ficha do fabricante → mesmo modelo na Amazon via Tavily → identidade conferida: marca/modelo
      literais + mesma densidade + Jev; só especificação que não depende do tamanho). 1º teste: 0 produtos, recusas
      corretas (anúncios Probel na Amazon são outras versões: D20 vs D28/D33, linhas com outro nome)
- [x] estratégia inversa (`products <slug>`, padrão): anúncios da Amazon por tipo → marca no cadastro → ficha oficial
      no site do fabricante → mesmas travas (função única confirmAndRegister). 1º teste (15 anúncios): 0 produtos;
      gargalo é COBERTURA de fontes (marcas fora do cadastro, apelidos como Lucas Home=Ortobom, sites de fabricante
      que bloqueiam ou que a busca não alcança), não erro de identidade
- [x] catálogo híbrido: 3 produtos na página de molas ou espuma (Emma Original, Herval Alba, Ortobom Misto ISO 100),
      todos nível "só anúncio"; cadastro com apelidos de marca (Lucas Home = Ortobom) e Gazin Colchões
- [ ] produtos no piloto automático (etapa após página aprovada) e renovação da disponibilidade (< 30 dias) (a busca devolve
      Instagram/YouTube/Buscapé antes do fabricante; Emma recusa conexão; Ortobom carrega produtos por JS)
- [x] hospedagem Hostinger (Business u226814741): https://darkslategrey-rail-669974.hostingersite.com via GitHub Action → ramo deploy (plano B manual: `npm run deploy:hostinger`)
- [x] painel só-leitura com senha: https://srv2079501.hstgr.cloud/painel/ (timer de 5 min)
- [x] etapa "editor": só corta/encurta/junta blocos aprovados; reescrita só cita evidência que já estava no
      bloco; blocos reescritos voltam ao auditor e só a edição reprovada é descartada (1ª página: −2 blocos, ~11 créditos)
- [x] busca na web (Tavily, plano grátis) com teto mensal duro de 1.400 créditos e contador na VPS
- [ ] domínio definitivo bemapoiado.com.br (compra = ação humana) e hospedagem final

## Fase 3 — Autonomia  ← atual
- [x] discover: LLM planeja buscas → Tavily → só domínios do cadastro (data/registry/domains.json) → snapshot;
      domínio desconhecido vira sugestão, nunca fonte automática
- [x] revisão editorial (GPT): página correta mas inútil fica como rascunho. Regra do código: orienta,
      não "no", enchimento ≤ 25%, ≥ 2 critérios concretos (calibrada em 2 páginas; reavaliar)
- [x] pesquisa lê só trechos com os termos da pauta (máx. 3 por fonte)
- [x] triagem Jev (decisão tipada, ~0,0016 crédito) antes da busca e do extrator: pesquisa caiu de 40 para 2,9 créditos
- [x] memória da pauta (lacunas da revisão, fontes já lidas, tentativas) + comando `improve` (busca direcionada às
      lacunas → pesquisa só fontes novas → refaz e revisa; para cedo sem ganho; máx. 2 tentativas)
- [ ] 2ª página "colchão D28 ou D33": 1ª tentativa de improve achou 4 fichas Probel D28/D33 (+25 evidências) mas
      segue NÃO PUBLICÁVEL (43% enchimento). A tabela peso × densidade dos fabricantes não está em texto
      (provável imagem) → capacidade futura: ler tabela em imagem (modelo com visão), com o mesmo rigor literal
- [x] aprendizado acumulado (`engine learning`): rendimento por domínio, páginas inúteis, lacunas recorrentes, de
      TODAS as pautas; usado no planejador de buscas e no ranking; tabela no painel
- [x] motor agnóstico de nicho: tudo que é do tema saiu do código para `data/niche.json` (ver docs/NICHO.md)
- [x] `niche-bootstrap "<tema>"`: motor propõe perfil + cadastro de domínios em data/proposals/ (gov.br só com caminho
      do órgão; fabricantes conferidos acessando o site). Testado com "brinquedos": Inmetro, Falcão Bauer, 7 fabricantes
- [x] `plan "<dúvida>"`: pauta gerada pelo motor (perguntas respondíveis por fonte primária, termos de foco, tipos de
      produto do nicho), evitando lacunas que o histórico mostrou sem resposta. Testado: "travesseiro alto ou baixo"
- [x] piloto automático: fila (data/queue.json) → `autopilot` (plan→discover→research→page→improve/edit) →
      scripts/cycle.sh na VPS (git por código, ramo pagina/*) → Action testa + gate + abre PR. Tetos: ciclo 120,
      dia 150 créditos, Tavily 1.400/mês; trava contra ciclos simultâneos
- [x] 1º ciclo manual validado ("travesseiro alto ou baixo" → rascunho, 30% enchimento, 50 créditos) e timer diário ligado
- [ ] gerar as perguntas da pauta automaticamente a partir da dúvida principal
Admin próprio na VPS (pautas, disparo/pausa, teto de gasto, aprovação), sem depender do Claude.
discover automático (autocomplete + Planner exportado, depois Search Console), fila de pautas,
atualização periódica de fontes (re-snapshot detecta mudança de conteúdo pelo hash).

- [x] veredito humano + calibração da revisão (CLI; painel mostra concordância e divergências)
- [x] painel admin com escrita: veredito, fila, aceitar/descartar resultado do motor, rodar ciclo, trocar senha
- [ ] painel: orçamentos editáveis, aprovação de proposta de nicho
- [x] manutenção do catálogo no ciclo (renovar ≥7 dias, retirar sem oferta/trecho mudado) e produtos para página aprovada
- [x] identidade visual nova, ilustrações próprias por tipo, SEO técnico (JSON-LD, sitemap, OG)
- [x] domínio bemapoiado.com + indexação + verificação do Search Console
- [x] Search Console no motor (aguarda a chave da conta de serviço)
- [ ] com dados do Google: melhorar automaticamente páginas "quase na 1ª página" e reescrever título/descrição das pouco clicadas
- [ ] AdSense: reavaliar com domínio, política de privacidade/consentimento e tráfego orgânico estável
- [ ] imagens por IA para tipos de nicho novo (`images`), hoje manual
- [ ] ilustrações para tipos de nicho novo (hoje cai no genérico)
- [x] gasto real por chamada + saldo informado no painel; reserva contra 524; auditor Luna
- [x] re-auditoria de páginas publicadas no ciclo (remendo só no bloco; aceite humano)
- [x] cache de prompt: roteador não suporta (medido); remendo com contexto enxuto
- [ ] redação por seção (só se o 524 voltar mesmo com a reserva)
- [ ] token Hostinger restrito no GitHub para o Action forçar a implantação (hoje: aviso no painel)
- [ ] calibração da revisão com 8+ vereditos; tabelas HTML legíveis (feito, v3); leitura de tabela em imagem só se aparecer caso real; PA-API após 10 vendas
- [x] pautas sozinhas (autocompletar + Search Console), sem canibalização; redator Haiku com escalada; 4 ciclos/dia
- [ ] meta de 200 páginas: acompanhar taxa de aprovação e custo real por página no painel; ajustar
- [x] categorias (página, home agrupada), guias relacionados e trilha; painel em abas; aprendizado do redator
- [x] painel: editar texto à mão (com auditoria) e pedidos em texto livre (agente)
- [ ] edição de tabelas no painel; ler data/dev-requests.json no início de cada sessão de desenvolvimento
- [x] ajuste com pesquisa; tema editável pelo chat com prévia e aceite
- [x] exemplos à venda: 1 por tipo / 2 marcas, marcas citadas primeiro; ponte para anúncio bloqueado
- [x] links internos no texto (âncoras do assunto principal, mesma categoria, colocação determinística)
- [ ] renovação mensal das fontes; melhorias automáticas pelo Search Console; calibração com 8 vereditos
- [x] 21/10: trava da resposta curta, evidências limitadas ao redator, rede com nova tentativa, lições do editor, fila de ações, produto do editor, buscas na Amazon, painel sem oscilar (ver docs/AUDITORIA-2026-10-21.md)
- [ ] edição de tabelas no painel; registro de mudanças por página; hub por perfil na home
- [ ] agente de código (seção/componente novo) num ramo com testes, build e prévia; avaliar modelo gratuito na VPS

## Fase 4 — Motor autônomo, previsível e monetizável (plano de 22/10/2026)  ← atual
Objetivo do dono: seguir só o que o painel sugere e o motor melhorar sozinho a cada ciclo; motor replicável
para outros nichos; o site dar dinheiro. Régua: 20 páginas no ar (tração), depois 200.

Feito em 22/10:
- [x] checagem antes de escrever (regras "Se você…" sustentadas; sem regra, pauta adiada 3 dias)
- [x] juiz por maioria de 3 avaliações (estável 8/8; concorda com o editor em 6/8)
- [x] ajuste nunca piora a página (juiz compara antes e depois; evidências novas ficam)
- [x] correção sugerida com as regras das fontes + correção automática de rascunho fraco no ciclo (pillow top 0,5 → 3 de 4)
- [x] quadro de decisões (um cartão por assunto, sugestão, nota de leitor, correção pronta, antes × depois)
- [x] páginas modelo para redator e juiz; tabela de decisão dentro do Como decidir; ajuste sabe mover tabela
- [x] fila por volume de busca (Keyword Planner) e trava de pauta sem fabricantes cadastrados

### A. Previsibilidade (até 20 páginas) — a mesma página tem de ter o mesmo resultado
- [ ] **auditor estável**: medir auditando 2× o mesmo rascunho (% de blocos que mudam de veredito). Acima de 10%:
      reauditar só os blocos reprovados mais 2 vezes e valer a maioria (cadeira para obeso: aprovada inteira numa
      rodada, recusada por atribuição na seguinte)
- [ ] atribuição sem volta: bloco cujas evidências são de um só fabricante tem de nomear o fabricante (regra de
      código, antes do auditor), em vez de o auditor recusar e o redator errar de novo
- [ ] produtos coerentes com a página: página sobre um item (pillow top) mostra só produtos com o item, ou nenhum
- [ ] tabela fora do assunto não entra (densidade por peso numa página de pillow top)
- [ ] medir a correção automática: em quantos rascunhos ela sobe a nota e quantos viram aprováveis

### B. Autonomia — o editor só decide, e cada vez menos
- [ ] modo sombra: para cada página, gravar "o motor publicaria?" e a concordância com o veredito do editor
- [ ] publicação automática com resumo diário (editor só despublica), quando: concordância ≥ 9 de 10 por 2 semanas,
      nota de leitor 4 de 4 e auditoria limpa. **Só liga com autorização explícita do dono**
- [ ] fabricantes novos propostos pelo motor (domínios das buscas) com aprovação de 1 clique no quadro
- [ ] pautas novas sozinhas: Keyword Planner exportado + Search Console + autocompletar, com volume e sem canibalização
- [ ] manutenção sem editor: renovação mensal de fontes (hash muda → reauditoria), produtos, imagens

- [x] "Pedir ao motor" busca produtos para uma página e gera capa nova (23/10); o que o leitor vê vai para o quadro
- [ ] **"Pedir ao motor" como extensão da conversa com o desenvolvedor** (pedido do dono, 23/10): conversar e ele
      executar ações — aprovar/recusar do quadro, rodar ciclo, cadastrar fabricante proposto, produto por link,
      mover tabela, reordenar fila, relatórios com recomendação. Cada ação com a mesma trava do botão equivalente
- [x] tipo de produto para item específico (23/10): "Pedir ao motor" cria tipo novo (new_kind), marcado como
      acessório quando é vendido à parte; travas próprias (aceita o item avulso, recusa colchão completo);
      fabricante só ganha o tipo se já está no cadastro; vai para o quadro para aceite
- [x] aba "Páginas" no painel (23/10): uma linha por página no ar com nota do juiz atual, visitas, cliques na
      Amazon, Google, busca, filtro de categoria, ordenação e ações (pronta para 200+ páginas)

- [x] ajuste sem ganho vira aprendizado (23/10): quando o ajuste não melhora e a página ainda não decide, o que
      falta vira lacuna da pauta (data/source-gaps.json); a manutenção busca fonte para ela 1x/semana por até 3
      semanas e o enriquecimento reescreve se achar. "Descartar" ajuste de página no ar guarda fontes, evidências e
      lacunas e só desfaz o que o leitor veria

- [x] menos busca paga (23/10): o motor lê o mapa de páginas (sitemap) de cada fabricante cadastrado e escolhe pelas
      palavras do endereço; Tavily só onde o mapa não acha nada. Brave Search como reserva quando a cota da Tavily
      acaba ou ela cai; cota esgotada para a página nova limpo, sem adiar pauta

- [x] domínios novos avaliados pelo motor (23/10, pedido do dono): aprova ou bloqueia só com confiança ≥ 85%, deixa
      a dúvida para o editor, registra motivo em data/registry/decisions.json, revoga depois de 14 dias o que aprovou
      e não rendeu; "Desfazer" no painel

### C. Crescimento — tráfego
- [ ] Search Console no ciclo (com 20 páginas e 4 a 6 semanas de dados): título/descrição das pouco clicadas,
      melhoria das páginas entre a 8ª e a 20ª posição, pautas novas a partir das buscas reais
- [x] aviso de página nova (23/10): o sync lê o sitemap do site no ar e, no que mudou, avisa o IndexNow (Bing,
      buscas por IA) e reenvia o sitemap ao Google (exige a conta de serviço com acesso "Completo"). A API de
      indexação do Google é só para vagas e transmissões ao vivo: não usada
- [ ] grupos de páginas por tema com links internos fortes; hub por perfil na home

### D. Monetização
- [ ] todo guia com pelo menos 2 exemplos à venda de marcas citadas no texto (hoje vários guias sem nenhum coerente)
- [ ] painel: cliques na Amazon por página (o contador já registra) e taxa de clique por visita
- [ ] relatório de ganhos da Amazon no painel (importar o CSV do Associados), para saber quais páginas vendem
- [ ] PA-API depois das primeiras vendas qualificadas: foto real, preço e disponibilidade oficiais
- [ ] avaliar outras receitas só com tráfego estável: AdSense (política de privacidade já existe), outros programas de afiliados

### E. Replicação — segundo nicho
- [ ] métricas por página publicada: custo, tentativas, nota de leitor, aprovação de primeira
- [ ] segundo nicho com `niche-bootstrap` quando o primeiro passar de 50 páginas com aprovação de primeira ≥ 70%
- [ ] alerta quando ciclo falhar ou o site ficar desatualizado (hoje só no painel)

Ordem: A até 20 páginas → B (modo sombra) e C/D a partir de 20 → publicação automática e PA-API perto de 50 → E.
