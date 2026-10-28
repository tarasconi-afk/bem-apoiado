#!/usr/bin/env bash
# Vigia: confere se o motor TEM COMO trabalhar, independente de haver ciclo. Três vezes ao dia.
#
# Existe para cobrir o que o próprio ciclo não consegue contar: o ciclo deixar de rodar. Se o timer quebrar, se a
# trava ficar presa ou se a VPS reiniciar no meio, as checagens dentro do cycle.sh ficam mudas junto com ele.
#
# Custo: uma chamada mínima de IA por passada (~0,0003 crédito) e nenhuma busca.
set -uo pipefail
REPO=${BEM_REPO:-/opt/bem-apoiado/repo}
ESTADO=${BEM_STATE_DIR:-/var/lib/bem-apoiado}
cd "$REPO"

# 1) O provedor aceita trabalhar?
PRE=$(npm run -s engine -- preflight 2>&1)
CODE=$?
printf '%s\n' "$PRE"
if [ $CODE -eq 4 ]; then
  LINHA=$(grep '^BLOQUEADO|' <<<"$PRE" | head -1)
  SERVICO=$(cut -d'|' -f2 <<<"$LINHA"); DETALHE=$(cut -d'|' -f4 <<<"$LINHA"); RESOLVER=$(cut -d'|' -f5 <<<"$LINHA")
  "$REPO/scripts/alerta.sh" "provedor-$SERVICO" "Bem Apoiado: o motor está parado ($SERVICO)" \
    "Conferência das $(date +%H:%M), fora de ciclo.

$DETALHE

O que fazer: $RESOLVER

Enquanto isso, nenhuma página nova sai. O site no ar continua normal." || true
fi

# 2) O ciclo ainda está rodando? São quatro por dia (04h, 10h, 16h, 22h); mais de 9 horas sem nenhum é defeito.
#    Silêncio é o pior estado: sem isto, um timer quebrado passa dias sem ninguém notar.
LIVE="$ESTADO/cycle-live.json"
LIMITE_H=${BEM_VIGIA_SEM_CICLO_H:-9}
if [ -f "$LIVE" ]; then
  IDADE_H=$(( ( $(date +%s) - $(stat -c %Y "$LIVE") ) / 3600 ))
  if [ "$IDADE_H" -ge "$LIMITE_H" ]; then
    "$REPO/scripts/alerta.sh" ciclo-sumiu "Bem Apoiado: faz ${IDADE_H}h que nenhum ciclo roda" \
      "O último ciclo terminou há ${IDADE_H} horas, e eles deveriam acontecer de 6 em 6 (04h, 10h, 16h, 22h).

O que fazer: no painel, use 'Rodar um ciclo agora'. Se nada acontecer, o agendamento da VPS parou
e precisa de uma olhada em systemctl list-timers." || true
  fi
fi
exit 0
