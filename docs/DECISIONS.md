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
