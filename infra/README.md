# Infraestrutura (VPS srv2079501)

- `Caddyfile` → `/etc/caddy/Caddyfile`. Site estático em `/var/www/bem-apoiado`, painel em `/var/www/painel`
  protegido por senha (`basic_auth`). Gerar o hash com `caddy hash-password`; a senha fica em
  `/etc/bem-apoiado/painel-senha` (root, 600) e nunca entra no git.
- `bem-apoiado-status.{service,timer}` → `/etc/systemd/system/`. Regenera o painel a cada 5 min como
  usuário `bemapoiado` (sem privilégio).
- Credenciais do motor: `/etc/bem-apoiado/env` (root:bemapoiado 640) com `NEXOS_API_KEY` e `NEXOS_BASE_URL`.
- Código do motor: `/opt/bem-apoiado/app` (dono `bemapoiado`).
- Firewall: só 22, 80 e 443.
- `bem-apoiado-cycle.{service,timer}` → piloto automático diário às 04:00 (America/Sao_Paulo): roda
  `scripts/cycle.sh` em `/opt/bem-apoiado/repo` (clone pela chave de deploy `/opt/bem-apoiado/.ssh/github_deploy`).
  Rodar um ciclo agora: `systemctl start bem-apoiado-cycle.service`; log: `journalctl -u bem-apoiado-cycle -o cat`.
- Tetos: 120 créditos/ciclo, 150/dia (`/var/lib/bem-apoiado/llm-usage.json`), Tavily 1.400/mês.
