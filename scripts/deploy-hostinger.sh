#!/usr/bin/env bash
# Deploy MANUAL por pacote (plano B). O caminho normal é: push no main → GitHub Action → ramo deploy → Hostinger.
# build (com validate) → zip → upload TUS para public_html → deploy do arquivo.
# Token REST em ~/.config/bem-apoiado/hostinger-api-token (fora do repositório).
# ATENÇÃO: o deploy substitui todo o conteúdo do site de destino.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-darkslategrey-rail-669974.hostingersite.com}"
USERNAME="${2:-u226814741}"
API=https://developers.hostinger.com/api/hosting/v1
TOKEN=$(cat "$HOME/.config/bem-apoiado/hostinger-api-token")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

SITE_URL="https://$DOMAIN" npm run -s build
(cd site/dist && zip -qr "$WORK/site.zip" .)
SIZE=$(stat -f%z "$WORK/site.zip" 2>/dev/null || stat -c%s "$WORK/site.zip")
ARCHIVE="bem-apoiado-$(date +%Y%m%d%H%M%S).zip"

# 1) credenciais de upload para o public_html do site
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"domain\":\"$DOMAIN\"}" "$API/files/upload-urls" > "$WORK/up.json"
URL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['url'])" "$WORK/up.json")
AUTH=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['auth_key'])" "$WORK/up.json")
REST=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['rest_auth_key'])" "$WORK/up.json")

# 2) upload TUS (cria + envia)
curl -fsS -o /dev/null -X POST "$URL/$ARCHIVE?override=true" -H "X-Auth: $AUTH" -H "X-Auth-Rest: $REST" \
  -H "Tus-Resumable: 1.0.0" -H "Upload-Length: $SIZE" -H "Upload-Offset: 0"
curl -fsS -o /dev/null -X PATCH "$URL/$ARCHIVE?override=true" -H "X-Auth: $AUTH" -H "X-Auth-Rest: $REST" \
  -H "Tus-Resumable: 1.0.0" -H "Content-Type: application/offset+octet-stream" -H "Upload-Offset: 0" \
  --data-binary "@$WORK/site.zip"

# 3) deploy do arquivo (substitui o conteúdo do site)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"archive_path\":\"$ARCHIVE\"}" "$API/accounts/$USERNAME/websites/$DOMAIN/deploy" -o /dev/null -w "deploy: %{http_code}\n"

sleep 5
curl -sS -o /dev/null -w "publicado: %{http_code} https://$DOMAIN/\n" "https://$DOMAIN/"
