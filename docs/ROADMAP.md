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
Deploy estático na Hostinger (domínio temporário, noindex), runner na VPS, catálogo curado de produtos
com links de afiliado (tarasconi-20) ligados a evidência de especificação do fabricante.

## Fase 3 — Autonomia
discover automático (autocomplete + Planner exportado, depois Search Console), fila de pautas,
atualização periódica de fontes (re-snapshot detecta mudança de conteúdo pelo hash).
