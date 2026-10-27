#!/usr/bin/env bash
# Aviso por email do que o editor NÃO vê sem abrir o painel: ciclo que falhou e site parado numa versão antiga.
# 27/10, pergunta do editor sobre roadblocks: hoje essas duas coisas só aparecem no painel, e num dia sem abrir o
# painel o site pode ficar desatualizado sem ninguém perceber.
#
# Uso: alerta.sh <chave> <assunto> <corpo…>
#   <chave> é o que não se repete: o mesmo aviso só sai de novo depois de REPETIR_H horas (um ciclo quebrado
#   quatro vezes por dia não vira quatro emails).
#
# Sem credencial configurada, grava no registro e sai bem: o alerta nunca derruba quem o chamou.
# Para ligar, em /etc/bem-apoiado/env:
#   BEM_ALERT_TO=destino@exemplo.com
#   BEM_ALERT_FROM=motor@bemapoiado.com
#   BEM_ALERT_SMTP=smtps://smtp.hostinger.com:465
#   BEM_ALERT_USER=motor@bemapoiado.com
#   BEM_ALERT_PASS=<senha da caixa>
set -uo pipefail

CHAVE=${1:-aviso}
ASSUNTO=${2:-Bem Apoiado}
shift 2 2>/dev/null || true
CORPO=${*:-}

ESTADO=${BEM_STATE_DIR:-/var/lib/bem-apoiado}
REGISTRO="$ESTADO/alertas.log"
MARCA="$ESTADO/alerta-$CHAVE.at"
REPETIR_H=${BEM_ALERT_REPEAT_H:-12}

mkdir -p "$ESTADO" 2>/dev/null || true
printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$CHAVE" "$ASSUNTO" "$CORPO" >> "$REGISTRO" 2>/dev/null || true

# Mesmo aviso dentro da janela: fica só no registro.
if [ -f "$MARCA" ]; then
  ANTES=$(cat "$MARCA" 2>/dev/null || echo 0)
  AGORA=$(date +%s)
  if [ $((AGORA - ANTES)) -lt $((REPETIR_H * 3600)) ]; then
    echo "alerta '$CHAVE' repetido dentro de ${REPETIR_H}h: só no registro"
    exit 0
  fi
fi

if [ -z "${BEM_ALERT_TO:-}" ] || [ -z "${BEM_ALERT_SMTP:-}" ] || [ -z "${BEM_ALERT_USER:-}" ] || [ -z "${BEM_ALERT_PASS:-}" ]; then
  echo "alerta '$CHAVE' registrado (email não configurado: falta BEM_ALERT_TO/SMTP/USER/PASS em /etc/bem-apoiado/env)"
  exit 0
fi

DE=${BEM_ALERT_FROM:-$BEM_ALERT_USER}
MSG=$(mktemp)
# Cabeçalhos mínimos e corpo em texto puro; Date no formato do RFC 5322 para o email não cair em spam por data ausente.
{
  printf 'From: Bem Apoiado <%s>\r\n' "$DE"
  printf 'To: %s\r\n' "$BEM_ALERT_TO"
  printf 'Subject: %s\r\n' "$ASSUNTO"
  printf 'Date: %s\r\n' "$(date -R)"
  printf 'Content-Type: text/plain; charset=UTF-8\r\n'
  printf '\r\n'
  printf '%s\r\n\r\n' "$CORPO"
  printf 'Painel: https://admin.bemapoiado.com/\r\n'
} > "$MSG"

if curl -s --max-time 30 --url "$BEM_ALERT_SMTP" --ssl-reqd \
  --mail-from "$DE" --mail-rcpt "$BEM_ALERT_TO" \
  --user "$BEM_ALERT_USER:$BEM_ALERT_PASS" --upload-file "$MSG"; then
  date +%s > "$MARCA"
  echo "alerta '$CHAVE' enviado para $BEM_ALERT_TO"
else
  echo "alerta '$CHAVE' NÃO enviado (falha no SMTP); fica no registro $REGISTRO"
fi
rm -f "$MSG"
exit 0
