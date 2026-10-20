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
