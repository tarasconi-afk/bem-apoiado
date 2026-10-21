# Infraestrutura (VPS srv2079501)

- `Caddyfile` → `/etc/caddy/Caddyfile`. Prévia em `/var/www/bem-apoiado` (com rascunhos); `/painel/` é
  proxy para o painel admin.
- `bem-apoiado-admin.service`: painel admin (`npm run engine -- admin`, 127.0.0.1:8787, usuário `bemapoiado`).
  A senha é conferida pelo painel (hash scrypt em `/var/lib/bem-apoiado/painel-auth.json`, 600) e trocada
  pela própria tela. Definir sem a tela: `npm run -s engine -- admin-senha` lendo a senha da entrada padrão.
  10 erros seguidos bloqueiam o IP por 15 min. POST só com Origin do próprio painel (CSRF).
  Sai sozinho quando o main traz código novo; o `Restart=always` sobe a versão nova.
- Ações do painel → `scripts/painel-acao.sh` (veredito, fila, aceitar/descartar resultado do motor), com o
  mesmo lock do ciclo; cada uma vira commit no main pela chave de deploy.
- `bem-apoiado-sync.{service,timer}`: a cada 5 min alinha a cópia com o GitHub e refaz a prévia se o main mudou.
- `bem-apoiado-cycle-now.path`: o botão "Rodar um ciclo agora" cria `/var/lib/bem-apoiado/run-now`, que dispara
  `bem-apoiado-cycle.service` (o `cycle.sh` apaga o arquivo).
- Credenciais do motor: `/etc/bem-apoiado/env` (root:bemapoiado 640) com `NEXOS_API_KEY` e `NEXOS_BASE_URL`.
- Código do motor: `/opt/bem-apoiado/app` (dono `bemapoiado`).
- Firewall: só 22, 80 e 443.
- `bem-apoiado-cycle.{service,timer}` → piloto automático diário às 04:00 (America/Sao_Paulo): roda
  `scripts/cycle.sh` em `/opt/bem-apoiado/repo` (clone pela chave de deploy `/opt/bem-apoiado/.ssh/github_deploy`).
  Rodar um ciclo agora: `systemctl start bem-apoiado-cycle.service`; log: `journalctl -u bem-apoiado-cycle -o cat`.
- Cada ciclo começa pela manutenção do catálogo: recaptura anúncios com prova de disponibilidade com 7+ dias
  (só Tavily; retira o produto se o trecho sumiu, se não há oferta ou se a prova venceu) e busca exemplos para
  página aprovada sem produto (uma tentativa por página por semana, se sobrarem 20+ créditos). Sem pauta na
  fila, só a manutenção vira ramo `pagina/manutencao-produtos-*`. Tentativas ficam em
  `/var/lib/bem-apoiado/products-{refresh,attempts}.json`.
- Tetos: 60 créditos/ciclo (nunca acima do que resta no dia), 100/dia em 2 ciclos (04:00 e 14:00) (`/var/lib/bem-apoiado/llm-usage.json`), Tavily 1.400/mês.
