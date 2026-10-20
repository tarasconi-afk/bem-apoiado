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
