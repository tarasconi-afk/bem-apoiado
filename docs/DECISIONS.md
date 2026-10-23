# Decisões

## 2026-10-20 — Nicho: sono e home office
Pesquisa em `~/Downloads/Ferramentas/pesquisa-nicho/` (autocomplete Google BR + Keyword Planner).
Volume de decisão: escritório/sono ~50 mil/mês, fitness ~36 mil, bebê ~22 mil; lance mediano R$ 2,27
vs 1,49 vs 0,85. Concorrência são comparadores e blogs de varejo com conteúdo genérico e contraditório.
Marcas relevantes (Emma, Luuna, Ortobom, Castor) estão na Amazon BR. Começa por sono; ergonomia depois.
Bebê (13% + bônus Lista do Bebê) fica como segundo site quando o motor estiver provado.

## 2026-10-20 — Marca: Bem Apoiado
Serve para colchão, travesseiro, cadeira e mesa sem prometer efeito de saúde. `bemapoiado.com.br`
estava livre no registro.br nesta data (não registrado ainda).

## 2026-10-20 — Sem n8n; código puro com estado em arquivo
O projeto anterior (Ferramenta Clara) gastou a maior parte das rodadas brigando com o n8n: lógica
copiada em vários nós sem módulo comum, expressões que truncam, subworkflow inativo que não roda,
workflows fora do git. Aqui cada estágio é uma função TypeScript testável, e o estado é JSON em `data/`.
Motor de workflow (Temporal/Windmill) só se houver vários nichos rodando juntos.

## 2026-10-20 — Evidência literal, conferida por código
O LLM não "atribui" fonte; ele aponta um `claim_id` e o claim carrega um trecho que o código encontra
literalmente no snapshot. Lição do projeto anterior: atribuição errada não se corrige com prompt, e sim
tirando a opção errada do contexto e exigindo identificador de lista fechada.

## 2026-10-20 — Redator e auditor de fornecedores diferentes
Mesmo modelo auditando a si mesmo tende a concordar consigo. Gateway Nexos permite modelos distintos.

## 2026-10-20 — Gate humano = merge de PR
Em vez de um painel Admin próprio, o PR no GitHub mostra a página e o relatório de auditoria.

## 2026-10-20 — Raspagem de buscadores e Amazon a partir da VPS não funciona
Bing devolve resultados degradados e a Amazon responde 503 para IP de data center. Dados de produto
virão do catálogo curado (SiteStripe) e, após 10 vendas, da PA-API.

## 2026-10-20 — LLM via Hostinger AI Router, não api.nexos.ai
Chaves novas `sk-hstgr-` só funcionam em `https://router.hostinger.com/v1` (api.nexos.ai devolve 401).
O catálogo da chave (`GET /models`) é menor que a lista do painel e usa ids textuais (`claude-opus-5`),
não os UUIDs mostrados no painel. Papéis atuais: extrator `claude-haiku-4.5`, redator `claude-opus-5`,
auditor `gpt-5.6-sol`. O modelo se autodeclara com nome errado na resposta; isso é normal e irrelevante.
Credencial em `/etc/bem-apoiado/env` (root:bemapoiado 640) na VPS; o motor roda como usuário `bemapoiado`.

## 2026-10-20 — Schema de saída vai também no prompt
O roteador não impõe `response_format` para o Claude: o extrator trocou `question_id` por `question`
e 7 de 15 chamadas falharam. Com o JSON Schema anexado ao prompt de sistema, 0 falhas de formato.
O verificador literal rejeitou 6 de 100 trechos propostos (citações que não existiam na fonte).

## 2026-10-20 — Correção por remendo, não por reescrita
Reescrever a página inteira a cada volta não convergia (11→5→1 e depois 12→…→1 de novo): o redator
consertava um bloco e quebrava outro. Com remendos só nos blocos apontados e cache de auditoria por
conteúdo, convergiu 12→1→2→0. Reescrita completa só para problema de página inteira.

## 2026-10-20 — Streaming obrigatório
O redator passa de 100 s e a Cloudflare do roteador devolve 524. Com `stream: true` o problema some.

## 2026-10-20 — Custo: unidade errada e teto por execução
O preço da lista de modelos do painel está em créditos nexos; o saldo e o extrato estão em créditos
Hostinger (1 nexos = 100 Hostinger). A estimativa de "1,5 crédito/página" estava 100x abaixo: cada
chamada do redator Opus 5 custava ~40–50 créditos Hostinger e a depuração da 1ª página consumiu ~850.
Medidas: redator passou a ser Sonnet 5 (2,5x mais barato), `price` em créditos Hostinger em
`models.ts`, custo gravado em cada run e teto por execução (`--budget`, padrão 80 por página e 40 por
pesquisa) que para em SAFE_STOP antes de estourar.

## 2026-10-20 — O motor não pode depender do Claude
Diretriz do dono: o controle da criação de páginas tem de ficar na VPS, sem depender do Claude Code.
O motor já é uma CLI comum (`npm run engine -- research|page|status`) que roda sozinha na VPS.
Agora: painel só-leitura em /painel/ (senha). Depois que o motor rodar sozinho: um admin pequeno na
VPS para cadastrar pautas, disparar/pausar execuções, ajustar teto de gasto e aprovar páginas.

## 2026-10-20 — Deploy na hospedagem Hostinger pela API REST
Os conectores MCP de hosting/domínios dão 401 (o OAuth deles só cobre VPS). O deploy usa a API REST
com token pessoal guardado fora do repo: free-subdomain → onboarding no Business 1009138882 → upload
TUS → deploy do zip. O pedido Business 1008020760 devolve 404 para criar site (acesso compartilhado).
Em domínio temporário `*.hostingersite.com` a Hostinger serve o próprio robots.txt; o noindex fica
garantido pela meta robots e pelo cabeçalho X-Robots-Tag do `.htaccess`.
A VPS (Caddy) segue como segundo ambiente de preview e hospeda o painel e o motor.

## 2026-10-20 — Produto só com duas provas, exibido sem ranking
Especificação do produto vem da ficha do fabricante (anúncio de loja não prova especificação);
disponibilidade vem do anúncio da Amazon capturado do Mac (a Amazon bloqueia a VPS) até a PA-API.
A página mostra "Exemplos à venda" só dos tipos que a pauta explica, sem ordem de preferência, com
rel="sponsored". O gate barra nome promocional, anúncio de outro ASIN e disponibilidade com mais de 30 dias.

## 2026-10-20 — Publicação: main → Action → ramo `deploy` → Hostinger
Ligar a integração Git da Hostinger direto no `main` de um site estático copia o REPOSITÓRIO para a
pasta pública (aconteceu: código e data/ ficaram acessíveis e o site saiu do ar; não havia segredo no
repo). Correção: site temporário apagado e recriado (darkslategrey-rail-669974.hostingersite.com); um
GitHub Action testa, roda o gate, monta o site e publica só `site/dist` no ramo `deploy`; a Hostinger
acompanha o ramo `deploy`. A integração só pode ser ligada com a pasta pública vazia.

## 2026-10-20 — Busca: Tavily com teto mensal, chamada direta pela VPS
Dono não quer pagar busca: plano grátis com teto duro de 1.400 créditos/mês (margem sob 1.500),
contador em /var/lib/bem-apoiado/tavily-usage.json, checado antes de cada chamada; só busca básica
(1 crédito). Não instalamos a CLI/skill da Tavily: o motor chama a API REST, sem depender do Claude.

## 2026-10-20 — Correto não basta: revisão editorial antes de publicar
A 2ª página (D28 ou D33) passou na auditoria de evidência mas não respondia à dúvida (sem tabela
densidade × peso nas fontes achadas). Publicar página fina prejudica o site. Nova etapa: o GPT descreve
utilidade (responde? orienta? quais blocos são enchimento? que critérios concretos dá?) e o CÓDIGO decide.
1ª calibragem ("responde totalmente" obrigatório) reprovou as duas páginas: exigente demais para um site
que não inventa. Regra final separa as duas pelo enchimento (14% vs 45%) e pelos critérios concretos.

## 2026-10-20 — Jev como triagem; memória da pauta para tentar de novo sozinho
Jev (TypeSafe) não escreve: responde perguntas tipadas com probabilidade, só cobra entrada. Usado SÓ como
filtro antes das etapas caras (resultados de busca e trechos de fonte); se falhar, volta ao filtro por
termos. Na 2ª página, a pesquisa caiu de 40 créditos/29 chamadas para 2,9/4.
A pauta guarda lacunas apontadas pela revisão e fontes já lidas; `improve` usa isso para uma busca
direcionada sem reler o que já foi lido, com limite de tentativas.

## 2026-10-20 — Motor agnóstico de nicho e aprendizado recalculado do histórico
Meta do dono: dizer "vamos trocar para brinquedos" e o motor saber o que fazer. Tudo que era do tema
(prompts com "colchão/sono", regra de saúde, Inmetro fixo, tipos de produto, textos do site) foi para
data/niche.json. O aprendizado não fica em memória de sessão: é recalculado de data/ a cada uso
(rendimento por domínio, páginas inúteis, lacunas recorrentes). Erro pego nos dados reais: gov.br saiu
como "raramente rende" porque a 1ª pauta é anterior à memória de fontes lidas; fonte com evidência
agora sempre conta como lida.

## 2026-10-20 — Nicho novo e pauta nova saem do motor, aprovação é humana
`plan` cria a pauta a partir da dúvida; `niche-bootstrap` pesquisa um tema e propõe perfil + domínios em
data/proposals/ sem ativar nada. Duas correções vistas no teste com "brinquedos": portal compartilhado
(gov.br) nunca entra inteiro, só com o caminho do órgão; fabricante não vem de busca genérica, vem de
lista do modelo CONFERIDA acessando o site (título/domínio com a marca), e domínio estacionado é recusado.

## 2026-10-20 — Sem imagem da Amazon até a PA-API
O dono pediu imagem do produto na página e no botão. O contrato de Associados proíbe copiar foto da
página do produto (baixar ou hotlink); a imagem do SiteStripe foi descontinuada; o caminho permitido é a
PA-API (liberada após 10 vendas), com URL oficial atualizada a cada 24 h. Até lá, cartão só com texto;
risco de usar antes = encerramento da conta e perda de comissões.

## 2026-10-20 — Produtos em dois níveis (decisão do dono: híbrido)
"manufacturer": especificações da ficha oficial (trecho literal), identidade conferida (marca/modelo
literais, mesma densidade, Jev). "listing": sem ficha oficial; o cartão mostra só "anunciado como" com um
trecho literal do anúncio e o aviso de que é a descrição do vendedor; nenhuma especificação.
Travas que só apareceram ao LER o cartão gerado (testes não pegavam): linha de imagem do anúncio virando
trecho (URL de foto da Amazon), "Suporte para Coluna" do vendedor (termos proibidos do nicho agora valem
também para anúncio e ficha, com palavra inteira para termos curtos: "dor" ≠ "vendedor"), modelo trocado
(Herval Lucca × Alba: rótulo tem de estar no trecho), bolsa de colchão como "colchão de espuma" (Jev
confirma que o anúncio vende o próprio item; marca começando com artigo é recusada), nome "MISTO" num
produto classificado como espuma (conflito de tipo recusa). Lição: inspecionar a SAÍDA renderizada antes de publicar.

## 2026-10-20 — Calibração da revisão por veredito humano, não por merge de PR
O merge de um PR do motor não é aprovação: o PR do travesseiro levou um rascunho ao repositório e ele
continuou fora do ar. O sinal humano passa a ser explícito: `verdict <slug> approve|reject --reason`,
gravado em data/feedback/ com as métricas que a revisão automática tinha medido. Aprovar exige auditoria
`pass` e gate limpo; recusar volta a página a rascunho e o motivo vira nota editorial da pauta (o redator
o recebe na próxima tentativa). `calibrate` busca em grade os limites (enchimento máximo, critérios
mínimos) que mais concordam com o editor; só aplica com 8+ vereditos e ganho real, gravando
data/calibration.json (versionado, auditável). O autopilot recalibra no início de cada ciclo.
Afiliado: tag bemapoiado-20 (sem sobrenome); a divulgação da Amazon fica no rodapé de todas as páginas,
não repetida em cada seção, e o cartão "só anúncio" se atribui pelo próprio "Anunciado como".

## 2026-10-20 — Painel admin com escrita, sem token do GitHub
Cada clique vira um job de `scripts/painel-acao.sh` com o lock do ciclo: parte do main do GitHub, aplica a
mudança pelo CLI do motor, passa no gate e faz commit direto no main pela chave de deploy. O clique é a
aprovação humana, então não há PR intermediário. "Aceitar" o resultado de um ciclo faz o merge do ramo
`pagina/*` localmente depois de testes + typecheck + build, como o check do PR; o GitHub marca o PR como
mesclado sozinho. Isso dispensa token do GitHub. A senha saiu do `basic_auth` do Caddy e foi para o painel
(scrypt, fora do git), para poder ser trocada pela tela sem root. A prévia da VPS passa a mostrar rascunhos:
é onde o editor lê a página antes do veredito.
Recusa devolve uma tentativa de melhoria e usa o motivo como lacuna, se a pauta não tiver outra; sem isso
o piloto automático considerava a pauta resolvida e nunca voltava a ela.
Exemplos à venda no meio da página (depois de tipos e diferenças), não no fim: no fim quase ninguém chega.

## 2026-10-20 — Identidade visual, ilustrações próprias e SEO técnico
Referências: Wirecutter (guia em coluna única, foco na escolha, identidade por ilustração própria) e
Examine (citação em cada afirmação como argumento de confiança). Paleta verde-escuro + âmbar sobre fundo
creme; Fraunces 600 nos títulos (hospedada no site, 20 KB) e fonte do sistema no corpo. Logo: um "b"
que é também uma cama de perfil. Imagens: ilustrações esquemáticas geradas por código
(`Illustration.astro`), uma por tipo de produto; mostram construção (o que a foto genérica não mostra),
sem risco de licença. Fotos do Commons foram avaliadas e recusadas (ver IMAGES.md). Cartão de produto usa a
ilustração do tipo com o aviso "ilustração do tipo"; foto real só via PA-API.
Página: resposta curta antes do sumário no celular; sumário lateral fixo no desktop; "Como decidir" em bloco
escuro; exemplos em grade de 3. Corrigido: o estilo das citações nunca era aplicado (CSS isolado do Astro).
SEO: JSON-LD Article (com `citation`) + BreadcrumbList, WebSite/Organization na home, sitemap.xml só com
páginas aprovadas, Open Graph 1200×630 por tipo, apple-touch-icon. Indexação continua desligada.
Produto com disponibilidade vencida some do site e só avisa no validate: tempo não é violação de integridade.
Google Ads: só como teste pequeno depois de domínio + ~10 páginas, com ID de rastreamento próprio
(ex.: bemapoiado-ads-20) para medir a venda daquele tráfego. Orgânico é o modelo.

## 2026-10-21 — Imagens realistas por IA; prévia de ramo no painel; AdSense adiado
O dono achou as ilustrações em SVG amadoras. O AI Router tem `gpt-image-2`: ~5 créditos por imagem média
(`credits_charged` já vem em créditos Hostinger, conferido contra uma chamada de texto). Oito imagens (capa
+ uma por tipo) por ~40 créditos; construção conferida a olho (molas ensacadas em tecido, Bonnell em
ampulheta com arame, misto com espuma grossa). Etapa `images` no motor, com registro auditável (prompt,
modelo, custo, sha256). O site sinaliza "imagem ilustrativa gerada por IA" e nunca a usa como produto.
A capa com selos flutuantes ("Norma técnica"...) não comunicava nada: virou foto do quarto.
Contraste: tabela dentro do bloco escuro "Como decidir" herdava texto claro sobre fundo branco.
Prévia de ramo: o sync monta cada ramo `pagina/*` pendente com os dados do ramo e o código do main, em
`/painel/previa/<ramo>/` (atrás da senha); o painel linka a página, não o diff. Para isso o site aceita
`SITE_BASE`/`SITE_OUT_DIR` e os links internos passam por `href()`.
Removida da página D28 uma pergunta solta sobre "dor ou desconforto na coluna" (framing sem orientação).
AdSense (pergunta real do dono, não Google Ads): adiado. Exige domínio próprio, política de privacidade e
consentimento (LGPD), disputa atenção com o botão de afiliado e paga pouco com tráfego pequeno.
Reavaliar com domínio e tráfego orgânico estável.

## 2026-10-21 — Gasto real, 524 do redator, imagens automáticas
Medido no roteador (1.500 tokens de saída): Haiku 4.5 0,81 crédito; Sonnet 5 1,8; Sonnet 4.6 2,7;
GPT 5.6 Sol 5,41; GPT 5.5 5,41; GPT 5.6 Luna 0,22; Gemini 3.5 Flash 1,62; Opus 5 4,5. Só Haiku e Sonnet 4.x
fazem streaming de verdade; Sonnet 5, GPT e Gemini entregam tudo no fim, então "stream" não protege contra
o corte de 100 s da Cloudflare. Ciclo de 21/10 perdeu a página do travesseiro com 524 no redator.
Correção: até 2 novas tentativas espaçadas (15 s, 45 s) e, com 524 persistente, a mesma chamada vai para o
Sonnet 4.6 (streaming real). Tabela do Sonnet 5 corrigida para 240/1200 (o valor cobrado era 20% maior).
Custo passa a vir de `usage.credits_charged` (valor do roteador), num livro-caixa por chamada
(STATE/credits-ledger.jsonl). O roteador não expõe saldo (endpoints testados: 404) e a API de billing da
Hostinger não tem créditos de IA: o dono informa o saldo do hPanel no painel e o painel desconta o gasto.
Imagens no ciclo: tipo do nicho sem imagem e capa de cada página aprovada (`pagina-<slug>`), até 2 por ciclo;
o pedido é escrito pelo Haiku e fica em briefs.json. A home prefere a capa da página (nunca repete imagem).

## 2026-10-21 — Auditor GPT 5.6 Luna (avaliação com erros plantados)
`scripts/eval-auditor.ts`: audita as páginas aprovadas e versões com 4 erros plantados por página (número
trocado, atribuição trocada, afirmação sem fonte, alegação de saúde). Luna e Terra pegaram 8/8; Sol estourou
40 créditos antes de terminar (raciocínio interno caro). Luna marcou nos originais erros reais que o Sol
aprovou (D33 "firme" sem o trecho dizer D33; "Inmetro certifica"; "muitas vezes" virando "sempre") e alguns
falsos alarmes (frase de transição como fato; orientação a profissional de saúde). Prompt ajustado: transição
não é fato; SAFETY_CLAIM se julga pelo texto do bloco. Depois do ajuste: 8/8 e zero falso alarme de transição,
1,85 crédito. Os dois erros reais foram corrigidos nas páginas publicadas.
Implantação da Hostinger às vezes não dispara no push do ramo `deploy` (21/10: ficou na versão anterior;
regravar as configurações de auto-deploy via API resolveu). O build carimba `bem-build` = commit; o sync
compara com o main e o painel avisa.

## 2026-10-21 — Re-auditoria, contexto enxuto nos remendos, tabelas legíveis (extrator v3)
Re-auditoria no ciclo: uma página publicada por ciclo (auditor trocado ou >30 dias); o que o auditor
apontar ganha remendo só no bloco e é auditado de novo; corrigida vai para o ramo de manutenção e só vai
ao ar com o aceite humano; não converge = página publicada intacta.
Cache de prompt: o roteador não repassa (cached_tokens 0 em repetição idêntica, Luna e Claude; com
cache_control o Claude cobrou 25% A MAIS). Preço real de entrada (créditos/M): Sol 602, Sonnet 4.6 361,
Sonnet 5 240, Gemini 3.5 Flash 182, Haiku 120, Luna ~24. Economia possível no redator: remendo envia só as
seções com bloco a corrigir (antes, o rascunho inteiro).
"Leitura de tabela em imagem" era o problema errado: a tabela densidade × peso × altura da Ortobom é uma
<table> HTML; o extrator v2 a achatava em palavras soltas ("D33"), que nenhum trecho podia sustentar. v3
acrescenta ao texto cada célula com rótulo de linha e coluna (cabeçalho diagonal incluído). Determinístico,
reproduzível do bruto, texto anterior intacto (0 violações após reextrair as 82 fontes).

## 2026-10-21 — Ciclo do travesseiro: onde foram 40 créditos
Livro-caixa real do ciclo: redator Sonnet 5 25,1 + reserva Sonnet 4.6 12,1 (o 524 voltou; a reserva
salvou a chamada) + auditor Luna 1,4. O redator é ~95% do custo. A página não convergiu por defeito
mecânico: remendo de linha de tabela com 3 células para 4 colunas, repetido em todas as rodadas. O schema
do remendo agora exige o número exato de células por linha (erro de validação volta ao redator com as
colunas), e remendo com forma errada nunca é aplicado.
Próxima economia grande: redação por seção (chamadas menores, sem 524, sem pagar a reserva).

## 2026-10-21 — "Aceitar" com conflito e com teste vermelho
O main mudou a pauta do travesseiro (reextração) enquanto o ramo do ciclo esperava: o merge do painel deu
conflito, a cópia da VPS ficou presa no meio do merge e o ciclo seguinte leu JSON com `<<<<<<<`. E, no aceite
anterior, `npm test && typecheck && build` falhou no teste mas o merge seguiu: `set -e` não para em lista com
`&&`. Agora: cópia sempre sai de merge interrompido (`merge --abort`, `checkout -f`); conflito em data/ vale o
ramo (`-X theirs`; ramo pagina/* só traz dados); cada etapa do gate é checada e, se falhar, nada é enviado.
O teste do livro-caixa escrevia no livro-caixa real da VPS (diretório de estado decidido no import): agora
lido na hora da chamada.

## 2026-10-21 — Domínio bemapoiado.com
O dono registrou bemapoiado.com na Hostinger (o .com.br fica para depois). Site novo no mesmo plano Business
(pedido 1009138882) via onboarding da API; implantação por Git no ramo `deploy` (a mesma do temporário);
DNS ajustado sozinho para a CDN da Hostinger; SSL vitalício ativo com redirecionamento HTTPS. Build passa
a usar SITE_URL=https://bemapoiado.com (canonical, sitemap, OG). Indexação continua desligada (noindex em
cabeçalho, meta e robots.txt) até instrução explícita do dono. O temporário segue publicando o mesmo ramo,
com canonical apontando para o domínio.

## 2026-10-21 — Indexação ligada (ordem explícita do dono)
SITE_INDEXABLE=true no deploy: meta robots index,follow, robots.txt com sitemap, sem X-Robots-Tag. Páginas
"approved" são indexáveis (antes o template só liberava "published", status que o fluxo nunca usa); rascunho
nunca é publicado. O temporário e o www fazem 301 para https://bemapoiado.com (sem conteúdo duplicado).
Prévias da VPS continuam noindex (sem SITE_INDEXABLE + cabeçalho do Caddy). Verificação do Search Console por
TXT no DNS (registro criado pela API).

## 2026-10-21 — Search Console no motor
Conta de serviço só leitura (webmasters.readonly), JWT RS256 assinado com node:crypto (sem SDK do Google).
Chave colada no painel, gravada na VPS (600), nunca no git. Retrato diário (28 dias até D-3, página×busca)
no diretório de estado; no git só entra o que muda o site: ordem da home (data/home-order.json, mais
cliques > mais impressões) e pautas novas (busca com ≥20 impressões, sem página, fora de tema vetado;
até 2/semana). Painel: tabela por página, "quase na 1ª página" (posição 8–20, ≥50 impressões) e "pouco
clicadas" (≥100 impressões, CTR < 1%). Ação automática sobre essas duas listas fica para quando houver
dados reais (hoje: zero tráfego).

## 2026-10-21 — Salvar página que quase converge; robots.txt em cache
Ciclo das 09:53: 40,8 créditos (37,8 no redator) e nenhuma página. O enriquecimento do D28 fez 4 rodadas e
sobrou UM bloco sem prova; a versão inteira foi descartada. Agora, se no fim restam até 3 blocos sem prova (e
nenhum é a resposta curta), eles são removidos e a página segue para gate e revisão editorial; remover nunca
acrescenta fato. Enriquecimento ganhou execução própria (o registro do D28 era sobrescrito pela página nova
do mesmo ciclo). A CDN da Hostinger segurou o robots.txt antigo (Disallow) depois que a indexação foi ligada;
purga pela API resolveu e robots/sitemap passam a ter cache de 5 min. Search Console: a organização Google
do dono (Hostinger) bloqueia criar chave de conta de serviço (iam.disableServiceAccountKeyCreation).

## 2026-10-21 — Mais páginas: fila do Planner, 2 ciclos/dia, teto 100
Fila reordenada por volume do Keyword Planner dentro do tema (sem "melhor" como ranking: vira "como
escolher"): como escolher colchão / travesseiro / cadeira de escritório (5.000 a 500.000 buscas/mês),
base box, mesa regulável, Emma ou Luuna, D33 ou D45; a fila antiga segue depois. Tipos novos no nicho:
base_box, mesa, suporte_notebook (as imagens saem sozinhas no ciclo). Cadência: 04:00 e 14:00; teto diário
100 (somado), teto por ciclo 60 e nunca acima do que resta no dia; página nova só começa com ≥35 créditos
sobrando (senão fica para o próximo ciclo, em vez de parar no meio da redação).
Limite conhecido: a busca só aceita domínios do cadastro; tema sem fabricante cadastrado (ex.: mesa
regulável) pode parar por falta de fonte. Resolvido no mesmo dia: o painel lista os domínios fora do cadastro que apareceram nas buscas (prefeituras,
diários oficiais e licitações filtrados) e o editor aprova (com classe e nome) ou bloqueia; vira commit no main.

## 2026-10-21 — Pautas descobertas sozinhas (autocompletar do Google) sem canibalização
Semanal, no ciclo (~3 créditos): sementes = tipos do nicho + nome-base ("colchão"), padrões de decisão
("X ou", "X qual", "como escolher X", "X vale a pena", "X diferença", "qual X"); triagem pelo Haiku com a
lista de pautas existentes e da fila. Variação de pauta existente não vira página (canibalização): vai para
data/topic-variants.json como busca daquela pauta. Família do mesmo atributo (densidades, tamanhos) vira
uma pauta-guia. "Qual o melhor X" vira "como escolher X". 5 por semana entram na fila; o resto fica em
data/ideas.json, visível no painel com "Pôr na fila". Primeira rodada real: 15 ideias distintas + 41
buscas mapeadas como variação das pautas existentes.
Também: o painel aceitou aprovar "gov.br" inteiro (liberaria prefeituras e diários como regulador);
revertido, e sufixo público passa a ser recusado. Imagens passam a contar no teto do ciclo.

## 2026-10-21 — Redator Haiku 4.5 com escalada ao Sonnet; 4 ciclos por dia
Avaliação na mesma pauta (molas ou espuma, todas as evidências), mesmo auditor Luna, cópias isoladas:
Sonnet 5 aprovada em 3 rodadas por 24,2 créditos; Haiku 4.5 aprovada em 4 rodadas por 7,8; Gemini 3.5 Flash
recusado pelo roteador (formato). Revisão: enchimento 21% × 24%, critérios 12 × 11. Defeito do Haiku: sem
seção final de decisão (a regra aceitava "como escolher" no meio da página) — agora a ÚLTIMA seção tem de ser
"Como decidir". Redator padrão = Haiku; página que não passa (não converge ou revisão reprova) ganha uma
segunda tentativa com Sonnet 5 se houver ≥30 créditos. Haiku faz streaming de verdade (sem 524).
Conta para 200 páginas: ~10 créditos (texto) + ~5 (capa) por página ≈ 3.000, contra ~10.000 com o Sonnet.
Cadência: 04:00, 10:00, 16:00, 22:00, uma página por ciclo (uma decisão por vez no painel); 40 por ciclo,
100 por dia; página nova com ≥15 créditos sobrando.

## 2026-10-21 — Aprendizado do redator, categorias, painel em abas
Redator recebe no prompt os erros mais apontados pelo auditor nos últimos 60 dias (tipo, contagem e um
exemplo real; ~150 tokens). Motivo de recusa humana não entra (é da página e já vai pelas notas da pauta).
Linha de base no painel (aba Desempenho): 3/10 tentativas aprovadas, 14 problemas por página na 1ª
auditoria, 3 rodadas por tentativa. Alavancas para subir a taxa: lições no prompt, salvamento por remoção,
escalada ao Sonnet, calibração com vereditos humanos.
Categorias no perfil do nicho (data/niche.json → categories): página /categoria/<id>/ (só com guia
publicado), home agrupada, "Guias relacionados" no fim de cada guia, trilha e JSON-LD de 3 níveis, sitemap.
Painel em abas (Decisões, Conteúdo, Desempenho, Motor, Configurações) por script pequeno que agrupa os h2;
vereditos mostram só o que precisa de decisão. Cadastro: consumidor.gov.br bloqueado (reclamações não são
norma técnica); o painel explica cada classe de fonte.

## 2026-10-21 — Tetos de desenvolvimento (temporário)
O dono autorizou gastar mais enquanto o motor é desenvolvido e testado: 250 créditos/dia e 60/ciclo (4
ciclos/dia). Voltar para ~100/dia e 40/ciclo quando a taxa de aprovação e o custo por página se firmarem.
Ajuste: BEM_DAILY_CREDIT_CAP e BEM_CYCLE_BUDGET em infra/bem-apoiado-cycle.service (e no admin, só exibição).

## 2026-10-21 — Reuso de evidências entre pautas
Primeiro ciclo com o fluxo novo (Haiku, lições, ideias): 16,1 créditos; re-auditoria corrigiu 2 blocos de
"molas ou espuma"; 5 pautas do autocompletar entraram na fila; "como escolher colchão" (15 evidências novas)
reprovada na revisão: 57% de enchimento e sem densidade, Inmetro e etiqueta, que o motor JÁ tinha verificado
para outras páginas (cada pauta só enxergava as próprias fontes). Agora, antes da pesquisa nova, a pauta
reaproveita evidências de pautas com os mesmos tipos de produto ou da mesma categoria: o Haiku só liga cada
evidência às perguntas novas (o trecho literal já foi conferido); a fonte entra como já pesquisada. A base
de evidências passa a acumular: página nova fica mais completa e mais barata.

## 2026-10-21 — Agente do painel (pedidos em texto livre)
Caixa "Pedir ao motor" (aba Decisões). O Haiku traduz o pedido em ações tipadas que o motor já executa com
as travas de sempre: add_topics (fila), redo_page (veredito de recusa com a instrução → o motor reescreve),
edit_text (escolhe blocos, o redator reescreve com as mesmas fontes, edição manual com auditoria: só grava se
sustentado), unpublish, report (gastos, qualidade, páginas, fila; montado dos dados, sem IA). Mudança de
código, visual, regra, orçamento, domínios ou integrações NÃO é executada: vira item de
data/dev-requests.json ("pedidos para o desenvolvedor"), lido na próxima sessão de desenvolvimento.

## 2026-10-21 — Sugestão do motor no painel; implantação forçada pelo Action
Cada resultado do motor e cada rascunho esperando veredito mostra "Sugestão do motor: aceitar/recusar" com os
números da revisão (responde à dúvida, enchimento × limite, critérios × mínimo, orientação), o resumo e o que
faltou; o editor decide e, se discordar, o veredito calibra a regra. A Hostinger voltou a não implantar o
push do ramo deploy no bemapoiado.com (ficou em 5e9e2e5 com o main em bc88fe8); o Action ganhou etapa que
força a implantação pela API se o segredo HOSTINGER_API_TOKEN existir (o token fica só nessa etapa).

## 2026-10-21 — Atacando o enchimento na origem
Amostra dos blocos marcados como enchimento pela revisão: quase todos descrevem o catálogo de uma marca ("a
Ortobom menciona espuma D26 e D33", "a Probel lista os tamanhos") ou são transições vazias. Causa provável:
o prompt pedia "página entre 700 e 1400 palavras", e com pouca evidência o redator enchia para chegar lá.
Agora: sem mínimo de palavras (curta e útil vale mais), regra explícita de que cada bloco tem de mudar o que
o leitor confere ou escolhe, e as lições do redator trazem exemplos reais de blocos cortados como enchimento.

## 2026-10-21 — Contador de visitas próprio (sem cookie); Google Analytics não
GA4 exigiria aviso de consentimento (cookies, LGPD), pesa na página e manda dado do leitor ao Google; o que
importa ao motor (visitas por página, origem, cliques em "Ver preço na Amazon") o contador próprio entrega, e o
Search Console cobre a busca. Coletor na VPS (127.0.0.1:8788, publicado em t.bemapoiado.com/c, DNS A → VPS),
aviso por navigator.sendBeacon só no site indexável. Sem cookie e sem IP guardado: visitante = sha256(sal do
dia + IP + navegador), sal trocado todo dia (não dá para seguir alguém entre dias); referência guardada só
como origem (google.com); robôs descartados; 60 avisos/min por IP. Painel (Desempenho → Visitas) e agente
("relatório de visitas") leem os arquivos diários. Página "Como trabalhamos" ganhou a seção Privacidade.

## 2026-10-21 — Status ao vivo do ciclo; primeira página nova aprovada de primeira
O ciclo do agendador não aparecia no painel (só as ações disparadas pelo painel). Agora cycle.sh grava
STATE/cycle-live.json (rodando/ok/falhou), o motor atualiza a etapa atual a cada writeStage e cada passo
concluído; o painel mostra "Ciclo em andamento · agora: <etapa> (rodada N)" com atualização a cada 10 s e,
depois, "Último ciclo" com os passos e, se falhou, as últimas 40 linhas do log.
Ciclo das 12:19 (fluxo novo completo: plano Sonnet, reuso, Haiku, lições, sem mínimo de palavras): "como
escolher travesseiro" aprovada de primeira (PASS) por 25,8 créditos com 29 evidências reaproveitadas de 16
fontes vizinhas. Primeira página do piloto automático que passa sem escalada.

## 2026-10-21 — "Pedir ajuste" antes de decidir
Sugestão do dono: além de aceitar/descartar, ajustar. Cada resultado do motor com página, cada rascunho e
cada página no ar tem um campo "pedir ajuste": o modelo escolhe os blocos, o redator reescreve com as MESMAS
fontes, a edição manual passa pela auditoria e só grava se sustentado. No resultado do motor o ajuste vira
commit no próprio ramo pagina/* (a prévia se refaz e o editor decide depois); em rascunho ou página no ar,
commit no main. Layout e visual continuam sendo pedido para o desenvolvedor.

## 2026-10-21 — Ajuste com pesquisa; tema editável pelo chat (etapa 1 de visual)
"Pedir ajuste" ganhou "pode pesquisar": a instrução vira pergunta da pauta, busca dirigida (4 buscas, até 5
fontes), pesquisa só nas novas, redator reescreve os blocos escolhidos podendo citar as evidências novas, gate
e auditoria nos blocos tocados; sem fonte nova, diz e não muda a página (~10–20 créditos).
Tema: data/theme.json (core/theme.ts, Zod com faixas: cores hex, radius 0–28, escala de texto 0,9–1,2,
títulos 0,85–1,2, botão de compra rótulo/estilo, posição dos exemplos, textos fixos). O agente tem a ação
"theme"; mudança de tema não vai ao main: vira ramo pagina/tema-* com prévia do site e só vale com o aceite.
Seção/componente novos continuam como pedido para o desenvolvedor (etapa 2: agente de código num ramo, no
futuro; avaliar modelos gratuitos rodando na própria VPS).
Corrigido: o aviso da última ação ficava no endereço (?msg=) e a atualização automática o repetia para sempre.
Nota técnica: no Zod 4, objeto aninhado com padrões internos precisa de .prefault({}) (.default({}) devolve o
objeto vazio sem aplicar os padrões; as cores do tema saíam "undefined").

## 2026-10-21 — Quantos exemplos à venda por página; Amazon bloqueando leitura dos anúncios
Pesquisa (Iyengar & Lepper 2000: 24 opções → 3% compram, 6 → 30%; Scheibehenne 2010: efeito médio ~0 em 50
experimentos; Chernev 2015: excesso de escolha aparece com decisão difícil, opções complexas e comprador
incerto — o nosso leitor): 3 opções não confundem; opções sem diferença clara, sim (o site não faz ranking).
Regra: página que compara tipos, 1 exemplo por tipo (até 3); página de um tipo só, 2 de marcas diferentes;
marcas citadas na página vêm primeiro; os exemplos herdados de outras páginas contam.
A Amazon passou a devolver página vazia à leitura automática (travesseiro: 8 de 9 anúncios; "advanced" do
Tavily também falha). Ponte até a PA-API: prova pelo título e resumo do anúncio no índice de busca, com o
endereço do próprio anúncio; só para marca do cadastro de fabricantes; o cartão diz "anúncio encontrado em",
nunca "disponibilidade conferida". Travas novas vindas do teste real: triagem recusa versão de viagem,
portátil, pet e infantil; marca genérica ("Espuma D33-20cm") recusada; "luxo", "premium" e "super" barrados
no nome do produto.

## 2026-10-21 — Links internos no texto; ciclo pedido durante ação do painel
Âncoras por página (data/link-anchors.json, auditável): o modelo barato propõe 3–6 expressões curtas do
assunto PRINCIPAL da página (1ª versão pegava subtemas de seção, "instruções de lavagem", que roubariam a
âncora de páginas futuras); cada âncora pertence a uma página só. A colocação é do site e determinística
(placeLinks): primeira ocorrência, 1 link por destino, 1 por bloco, até 4 por página, sem resposta curta e
tabela, só destino da mesma categoria ("densidades de espuma" num travesseiro levava à página D28/D33). O
texto não muda; nada a re-auditar. Cobertura inicial baixa (0–1 link por página): precisão antes de volume.
Produto com especificação no lugar da marca ("D33 Miami" → marca "D33") recusado na entrada e retirado na
renovação. Ciclo: o "rodar agora" chegou durante uma mesclagem (mesma trava), o ciclo saiu sem apagar o
pedido e o systemd o redisparou até travar o gatilho; agora espera a trava (até 30 min) e sem limite de
disparo.

## 2026-10-21 — "Esperando sua decisão" item por item; aprendizado entra sozinho
O editor não sabia por que aceitar um resultado "rascunho/SAFE_STOP" sem página para ver, que ainda trazia
correções da re-auditoria e um produto ruim misturados. Agora (changes.ts) cada resultado vira a lista do que
o LEITOR veria: texto de página no ar (antes → depois), página nova, exemplo à venda novo/retirado, tema,
imagens, links internos, ordem da home; cada item com caixa marcada e link da prévia na página afetada.
"Aplicar marcados" mescla e desfaz só os desmarcados (voltam à versão do main; produto recusado vai para
products-retired/ e a busca não o traz de volta). O resto (fontes, evidências, pautas, rascunhos, registros,
disponibilidade renovada) é aprendizado: resultado só com isso entra sozinho pelo sync, com o mesmo gate
(testes, typecheck, build); se falhar, fica para decisão. Motivo da parada traduzido ("as fontes encontradas
não responderam às perguntas"). Corrigido: respostas dos pedidos e "Último ciclo" caíam no fim da página
(o script das abas pulava todo elemento .flash).

## 2026-10-21 — Pauta de categoria nova sem fonte: fabricantes por tipo
"Como escolher cadeira de escritório" parou com 0 evidências: o planejador não sabia que marca faz o quê e
buscou cadeira no site da Probel; Cavaletti, Flexform e Frisokar estavam no cadastro e não foram buscados.
Agora cada fabricante do cadastro tem "kinds"; o planejador recebe os fabricantes do tipo da pauta e há uma
busca garantida no site de cada um (até 3). Tipo sem fabricante cadastrado (categoria nova): 2 buscas abertas,
cujos sites viram sugestão em "Domínios novos"; fabricante aprovado herda os tipos das pautas em que apareceu.

## 2026-10-21 — Resumo para leigos no topo; alcance da fonte; prévia com a imagem do ramo
Pesquisa: 57% do tempo de leitura fica na primeira tela e 74% nas duas primeiras (NN/g, eyetracking 2018);
pirâmide invertida (conclusão primeiro) para quem escaneia; anúncio logo acima da dobra é o mais visto
(Google, viewability 2014: 68% acima × 40% abaixo). Página agora: resposta curta → "Como decidir" (redator
instruído a escrever para leigo) → exemplos à venda → "Detalhes técnicos". Só a ordem muda: nada a re-auditar.
Cadeira (21/10): números do Anexo II da NR-17 (teleatendimento) viraram "a NR-17 exige" para toda cadeira,
e um manual de 2002 ("é preferível") virou exigência; cada trecho batia, então o auditor aprovou. Redator e
auditor passam a ver título e endereço do documento; generalizar anexo/setor ou "recomenda" → "exige" é
OVERSTATED; com duas versões do mesmo documento, vale a mais nova.
Prévia de resultado montava com as imagens do main: capa nova aparecia como a ilustração antiga. Agora usa as
do ramo; e o item mostra a miniatura da imagem nova.

## 2026-10-21 — Ajuste que corrige em vez de desistir; parte do documento de cada trecho
O ajuste da cadeira foi reprovado em 3 blocos e nada foi salvo. Agora o ajuste tem o ciclo do pipeline:
bloco reprovado volta ao redator com o problema e a versão sustentada que o auditor propôs (até 2 voltas);
o que ainda não passar volta ao texto anterior e o resto fica. Audita a seção inteira dos blocos tocados,
escolhe até 5 blocos, corrige título de seção que o pedido torna enganoso e segue sem fonte nova quando o
pedido é uma correção. Cada evidência mostra em que parte do documento está ("ANEXO II · TRABALHO EM
TELEATENDIMENTO", "texto principal"): o PDF inteiro da NR-17 traz os anexos e pelo endereço não dava para
saber; sumário no topo do PDF é ignorado. Bloco que situa algo numa parte que a evidência não mostra:
MISATTRIBUTED. Testado em cópia isolada com os dados reais da cadeira (~2–3,5 créditos por ajuste).

## 2026-10-21 — Público no centro: planejador, redator e revisão
A cadeira saiu correta mas escrita para o empregador: pauta planejada em torno de "o que a NR-17 exige",
resposta curta sobre análise ergonômica, "Como decidir" com jargão (antropométricas, datilo/relax) e apoiado
só na Flexform. Agora: o planejador gera as perguntas do leitor do nicho na hora da compra (norma é apoio,
não eixo); o redator escreve resposta curta e "Como decidir" para quem compra, sem obrigação de terceiros como
eixo e sem apoiar a decisão numa marca só quando há outras; a revisão avalia "reader_fit" e a regra de
publicação exige que não seja false (revisões antigas sem o campo continuam valendo). Os problemas de
leitura entram na lista "faltou" (viram lacuna e alimentam o "completar o que faltou").

## 2026-10-21 — Padrão editorial do dono: decidir, comprar, leigo, rápido
Quatro perguntas viram régua do site (packages/core/src/editorial.ts, AGENTS.md): ajuda a decidir? leva à
compra (o que conferir no anúncio/ficha, sem pressão)? é fácil para leigos? responde rápido a dúvida simples?
O redator recebe a lista; a revisão avalia "quick_answer" e "purchase_path" além de "reader_fit", e a regra
de publicação exige resposta curta que resolva sozinha e linguagem de leigo. "Leva à compra" falhando vira
item em "faltou" (não bloqueia: página sem exemplo à venda ainda pode orientar a compra).
Busca com IA do Google: não há otimização especial; valem as mesmas práticas de conteúdo útil e de SEO
(Google Search Central, "AI features and your website"; "Creating helpful, reliable, people-first content").
O modo IA faz buscas em leque por subtemas: página que responde direto a uma dúvida simples e traz as
comparações com fonte é o que esse modo pode citar.

## 2026-10-21 — Links de busca na Amazon; painel sem perder digitação; D28 restaurada
Ferramenta Clara não é bloqueado porque não lê a Amazon: ASINs conferidos por uma pessoa num catálogo curado.
Aqui, antes da PA-API: busca na Amazon com a nossa tag (amazon.com.br/s?k=...&tag=bemapoiado-20) em toda
página no ar; não aponta produto, então não há anúncio a ler nem a conferir. 1 a 3 por página, geradas uma vez
pelo modelo barato a partir do "Como decidir" (data/search-links.json), validadas (2 a 7 palavras, sem
promoção/ranking/termo vetado, uma medida no máximo); sem busca válida, cai no tipo de produto. Ficam junto dos
exemplos à venda (cartões dos colchões mantidos) ou sozinhas em "Opções na Amazon".
Painel: a recarga automática apagou um pedido de ajuste sendo digitado. Agora só recarrega sem campo em foco ou
preenchido, e cada campo guarda rascunho no navegador até o envio.
Erro meu: um teste novo carregou o módulo antes de trocar o BEM_ROOT e o teste de veredito gravou 2 recusas
falsas no repositório real, voltando a D28 para rascunho (saiu do ar). Restaurado; writeJson recusa gravar no
data/ real durante testes (BEM_REAL_ROOT no vitest).
Ajuste: com ou sem pesquisa, o mesmo caminho com correção; o alcance da fonte vai em palavras simples no resumo
e no "Como decidir" (nome técnico só nos detalhes), termo técnico explicado. Limite conhecido: o ajuste remenda
bloco a bloco e o Haiku mantém as palavras das fontes; reescrever o resumo inteiro para leigo ainda depende de
edição manual (Sonnet no ajuste passou de 15 créditos).

## 2026-10-21 — Renovação dos cartões com a Amazon bloqueando; sem contornar o bloqueio
A renovação relia o anúncio a cada 7 dias e retirava o cartão quando a prova passava de 30 dias: com a
leitura bloqueada, os 3 cartões dos colchões sairiam do ar por volta de 19/11. Agora, se a leitura falha, a
prova vem do título e do resumo do próprio anúncio no índice de busca (nome curto, título do anúncio ou ASIN),
só para marca do cadastro, e o trecho anterior tem de aparecer nele; o cartão passa a "anúncio encontrado em".
Conferido com os 3 colchões reais: todos achados, trecho batendo.
Contornar o bloqueio (navegador disfarçado, proxy residencial) não: é corrida armamentista com a Amazon e os
termos dela proíbem raspagem automática, o que arriscaria a conta de Associados. Caminho oficial: API da
Amazon (PA-API, migrando para a Creators API) depois das vendas.

## 2026-10-21 — Produto escolhido pelo editor
Como no Ferramenta Clara: o editor cola o link de um anúncio no painel (Conteúdo → Produtos à venda), com tipo,
marca e nome. Nível "editor" no catálogo: sem leitura do anúncio (a Amazon bloqueia), validado (ASIN do link,
tipo do nicho, marca plausível, nome com a marca e sem promoção ou termo vetado). Cartão igual aos dos colchões,
com a imagem do tipo gerada por IA (foto da Amazon só pela API), "conferido pelo editor em <data>; preço e
estoque podem mudar". Vale 45 dias sem reconferir; o painel avisa a partir de 30 e tem "Reconferi" e "Remover"
(removido vai para products-retired e a busca automática não traz de volta).

## 2026-10-21 — Pedidos do editor viram lição para todas as páginas
Os ajustes do editor corrigiam só a página pedida, e o motor repetia o erro na seguinte (resposta curta abrindo
pelo Inmetro na base box, depois de o mesmo pedido na cadeira). Agora: ajuste salvo e recusa com motivo passam
por um modelo barato que decide se o pedido vale para todas as páginas; se vale, vira regra curta em
data/editor-lessons.json (máx. 12, sem repetir), que o redator recebe em toda página e todo remendo, e que o
painel lista em "Pedir ao motor". Semeado com 4 lições dos pedidos de 21/10. Ajuste no main refaz a prévia na
hora (antes o editor via a versão antiga por até 5 min).

## 2026-10-21 — Painel atualiza só quando muda; lições do editor também na pesquisa
A recarga periódica voltava o editor para a aba Decisões no meio da leitura. Agora o navegador consulta
/estado (impressão digital de versão, ações, ciclo e resultados pendentes) a cada 10–30 s e só recarrega quando
ela muda e o editor não está escrevendo nem com uma saída aberta; volta na mesma aba e na mesma rolagem.
Decisões abre sozinha só na primeira visita da sessão.
As lições do editor passam a ir também para o planejador da pauta e para o planejador de buscas: um pedido
sobre o que pesquisar (ex.: medidas e peso suportado em fichas de mais de um fabricante) muda as próximas pautas,
não só o texto.

## 2026-10-21 — Ajuste não cai por parágrafo longo; lição sai mesmo se o ajuste falhar
Dois ajustes com pesquisa da base box foram perdidos pela regra de forma (parágrafos de 98 a 130 palavras;
limite 70), que derrubava o ajuste antes de qualquer correção. Agora o bloco volta ao redator com "encurte"
(até 2 voltas). O pedido do editor vira lição antes do ajuste, independente do resultado; "já coberta" só quando
uma regra diz a mesma coisa (o modelo descartou a regra de pesquisa por parecer com uma regra de texto; a lição
foi registrada à mão, a pedido explícito "para todas as páginas").

## 2026-10-21 — Escalada para o Sonnet desligada; resultado do ciclo em blocos
"Colchão firme ou macio": a 1ª tentativa (Haiku, ~9 créditos) ficou rascunho e a escalada Sonnet 5 gastou 36,5
e estourou o teto do ciclo (SAFE_STOP); ciclo inteiro 58,9. Com a base box (14 na escalada, rascunho igual),
a escalada não pagou nenhuma vez. Desligada por padrão (BEM_ESCALATION=1 religa); a página fica rascunho e o
editor ajusta (2–5 créditos).
Painel: o resultado do ciclo vem em blocos: (1) mudanças no site agrupadas por página, cada uma com o "por quê"
(resumo reescrito pela trava, re-auditoria, links internos, buscas na Amazon, capa nova), (2) página nova
tentada, com o desfecho, a sugestão da revisão e os botões de ajuste daquele rascunho (antes pareciam valer
para as melhorias), aprendizado e detalhes técnicos recolhidos; custo do ciclo no topo.

## 2026-10-21 — Correção: ações herdavam a cópia só de leitura do painel
Com o painel lendo /opt/bem-apoiado/view (BEM_ROOT), as ações disparadas por ele herdavam o BEM_ROOT: aplicar,
ajustar e montar a prévia liam os dados da cópia atrasada (a prévia saiu sem o rascunho "colchão firme ou
macio"; um ajuste gravaria na cópia errada). Desativado na VPS na hora e prévia refeita. Agora o painel passa
BEM_ROOT=cópia de trabalho às ações e painel-acao.sh/cycle.sh fazem unset BEM_ROOT. Reativar o painel na cópia
só de leitura depois deste envio.

## 2026-10-22 — Ajuste cria tabela e troca a descrição; forma conferida depois da correção do auditor
A edição direta da resposta curta falhou com razão: ela mantém as fontes do bloco, e o texto novo precisava
de outras. Pelo "Pedir ao motor" (que escolhe as fontes), a reescrita do resumo agora pode criar tabela no "Como
decidir" (cada linha auditada; 2 colunas, nunca coluna que a fonte não traz para todas as linhas) e trocar a
descrição do Google. A correção do auditor passa a manter as regras de forma, e a resposta curta é conferida de
novo no fim (a versão sustentada sugerida voltava a abrir com "Segundo a Castor"). O agente junta numa só
edição tudo o que foi pedido para a mesma página (antes: 3 rodadas, 14,3 créditos; agora 1, 4,1).

## 2026-10-22 — Tabela que some, pauta parada na auditoria, situação da fila
"Colchão firme ou macio": o pedido ao motor criou a tabela peso × densidade, o auditor recusou todas as linhas
(via cada linha solta, sem o título "segundo a Castor") e a tabela caiu, mas o texto "confira na tabela abaixo"
ficou e as faixas da Castor sumiram. Agora: o título da tabela vai junto de cada linha na auditoria; o título
diz de quem são os dados; texto que cita tabela inexistente é regra de forma; e se a tabela cair inteira, a
resposta curta e a seção de decisão voltam ao original (o ajuste não apaga conteúdo bom).
"Cadeira ergonômica ou gamer" parou na auditoria (AUDIT_NOT_CONVERGED) com 55 evidências e 0 lacunas, e a fila a
trataria como esgotada para sempre: agora os problemas abertos do auditor viram lacunas e a pauta volta.
Painel: cada pauta da fila mostra a situação (no ar, esperando você, rascunho, esgotada, próxima, na fila).
Fila: saem "colchão magnético" e "colchão com massagem" (promessa de saúde; vetados pela regra do nicho).

## 2026-10-22 — Forma consertada sem IA; cadeira gamer ganha mais uma tentativa
3ª parada da cadeira gamer: os problemas de conteúdo foram resolvidos, mas a resposta curta abria com "Segundo a
Ortobom/Flexform" em 4 rodadas (o redator ignorou a regra). Agora, antes de parar: a atribuição que abre a
resposta curta vai para o fim da primeira frase e travessão vira vírgula, sem IA (mesmo conteúdo e fontes); a
versão com a forma certa é auditada (ela nunca tinha sido, porque a forma barrava antes); se o auditor apontar
conteúdo, adota a versão sustentada dele, conserta a forma de novo e audita uma última vez. No rascunho real,
a resposta curta passou. A pauta tinha esgotado as 2 tentativas por esses defeitos do motor: volta para 1.

## 22/10/2026: padrão da ilustração de anúncio

Cada anúncio do catálogo tem a sua ilustração gerada por IA (`produto-<asin>`), aprovada pelo editor nas 5 cadeiras:
um único produto genérico do tipo, com a cor e o material que o anúncio descreve, num cômodo e num ângulo próprios
(rodízio dentro do mesmo tipo, `PRODUCT_SCENES` e `PRODUCT_VIEWS` em `packages/engine/src/images.ts`), sem marca,
logotipo nem modelo reconhecível; luz e paleta da casa iguais para todas. Foto real de produto só pela PA-API.
Anúncio novo ganha a sua no ciclo (até 2 imagens por ciclo, capas de página primeiro).

## 2026-10-23 · Capa da página em faixa (32:9) no topo
O editor comparou três topos na página do solteirão (capa 21:9, capa em faixa 32:9, resposta curta antes da capa) e
escolheu a faixa: a resposta curta aparece já na primeira tela, que é a 4ª pergunta do padrão editorial ("responde
rapidamente?"). Regra: toda página com capa própria mostra a capa em 32:9 no topo; a grade de tipos fica só nas
páginas cuja pergunta compara tipos (`comparesKinds`, site/src/lib/content.ts). A capa é gerada em 3:2, então o
pedido da imagem manda compor o assunto na faixa do meio (`COVER_FRAMING`, packages/engine/src/images.ts).

## 2026-10-23 · Checagem de fonte pelo mapa de páginas antes da vez: testada e descartada
Ideia: antes de pesquisar uma pauta nova, contar quantos fabricantes cadastrados têm página cujo endereço fala do
assunto (mapa de páginas, sem custo) e tirar da vez a pauta com menos de 2. Teste com a fila real e os mapas reais
(34 pautas): bloquearia 6 pautas que viraram páginas aprovadas (densidades, tamanhos de colchão, ensacadas ou Bonnel,
base para cama box, colchão para obeso, tamanhos de travesseiro) e deixaria passar 2 que as fontes não sustentavam
(pena ou fibra, colchão ou cama box). O endereço da página não diz se ela traz a informação: a evidência boa costuma
estar em tabelas e guias de nome genérico. Não foi ligada. A checagem que funciona continua sendo a de antes de
escrever (readiness.ts), que adiou as 3 pautas sem fonte gastando 2,6 a 10 créditos cada, sem redação. O desperdício
real (cadeira para obeso, ~50 créditos em 3 tentativas) já é cortado pelo limite de 2 novas tentativas por pauta.
