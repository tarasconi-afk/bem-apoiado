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
- [ ] popular o catálogo: busca já existe; falta a etapa que acha a ficha OFICIAL (a busca devolve
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
- [ ] 2ª página "colchão D28 ou D33": motor fez sozinho (discover→research→page, ~32 créditos na redação),
      revisão reprovou (45% enchimento: faltou tabela de densidade × peso). Próximo: usar a lista "missing"
      da revisão para uma 2ª rodada de discover direcionada (ex.: tabela de densidade da Probel/Ortobom)
- [ ] gerar as perguntas da pauta automaticamente a partir da dúvida principal
Admin próprio na VPS (pautas, disparo/pausa, teto de gasto, aprovação), sem depender do Claude.
discover automático (autocomplete + Planner exportado, depois Search Console), fila de pautas,
atualização periódica de fontes (re-snapshot detecta mudança de conteúdo pelo hash).
