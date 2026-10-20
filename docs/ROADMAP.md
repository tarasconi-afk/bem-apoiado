# Roadmap

## Fase 0 — Fundação ✅ (2026-10-20)
Monorepo, schemas, verificador de integridade com testes, snapshot de fontes (HTML e PDF),
site Astro com noindex por padrão, primeira fonte primária real (Portaria Inmetro 386/2013).

## Fase 1 — Primeira página de ponta a ponta (acionada à mão)  ← atual
Pauta: "colchão de molas ou espuma" (100–1 mil buscas/mês, lance ~R$ 3).
- [ ] gateway LLM (Nexos), saída estruturada validada por Zod, custo e modelo gravados no run
- [ ] research: lista de URLs candidatas → snapshot → LLM propõe trechos → código confere literalidade
- [ ] write: PageSpec a partir só dos claims aprovados
- [ ] audit: modelo de outro fornecedor, veredito por bloco
- [ ] loop de correção limitado (máx. 2 voltas, depois SAFE_STOP)
- [ ] PR no GitHub com página + relatório

## Fase 2 — No ar
Deploy estático na Hostinger (domínio temporário, noindex), runner na VPS, catálogo curado de produtos.

## Fase 3 — Autonomia
discover automático (autocomplete + Planner exportado, depois Search Console), fila de pautas,
atualização periódica de fontes (re-snapshot detecta mudança de conteúdo pelo hash).
