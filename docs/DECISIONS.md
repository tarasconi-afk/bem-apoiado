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
