#!/usr/bin/env bash
# Publica o site no ambiente temporário (VPS, Caddy, noindex em cabeçalho + meta + robots.txt).
# O build passa pelo `validate`: página com violação de evidência não chega ao servidor.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=root@200.141.17.249
KEY="$HOME/.ssh/novo_projeto_ed25519"
SITE_URL=https://srv2079501.hstgr.cloud npm run -s build
rsync -az --delete -e "ssh -i $KEY" site/dist/ "$HOST:/var/www/bem-apoiado/"
ssh -i "$KEY" "$HOST" 'chown -R bemapoiado:bemapoiado /var/www/bem-apoiado'
curl -fsS -o /dev/null -w "publicado: %{http_code} https://srv2079501.hstgr.cloud/\n" https://srv2079501.hstgr.cloud/
