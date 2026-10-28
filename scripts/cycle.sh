#!/usr/bin/env bash
# Um ciclo do piloto automático na VPS (usuário bemapoiado). O git é operado AQUI, por código;
# o LLM nunca executa git. Resultado vai para um ramo pagina/* e o Action abre o PR.
set -euo pipefail
# Sempre a cópia de trabalho: o painel roda com BEM_ROOT apontando para a cópia só de leitura.
unset BEM_ROOT
REPO=/opt/bem-apoiado/repo
export GIT_SSH_COMMAND="ssh -i /opt/bem-apoiado/.ssh/github_deploy -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
exec 9>/var/lib/bem-apoiado/cycle.lock
# A trava é a mesma das ações do painel (mesclar, veredito...), que duram segundos: espera em vez de sair.
# 21/10: o pedido "rodar agora" chegou durante uma mesclagem, o ciclo saiu sem apagar run-now e o systemd
# o redisparou até bloquear o gatilho (start-limit-hit).
if ! flock -n 9; then
  echo "trava ocupada (ação do painel); esperando"
  flock -w 1800 9 || { echo "trava ocupada há 30 min; saindo"; rm -f /var/lib/bem-apoiado/run-now; exit 0; }
fi

# Ciclo pedido no painel ("Rodar um ciclo agora") é manual: até 20 páginas no ar ele não conta o teto diário
# (decisão do editor, 22/10); o do horário automático conta.
if [ -e /var/lib/bem-apoiado/run-now ]; then export BEM_MANUAL_RUN=1; else export BEM_MANUAL_RUN=0; fi
rm -f /var/lib/bem-apoiado/run-now   # pedido do painel atendido
LIVE=/var/lib/bem-apoiado/cycle-live.json
printf '{"state":"rodando","started":"%s","updated":"%s","steps":[]}' "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" > "$LIVE"
# Fim do ciclo (qualquer saída): estado final + últimas linhas do log para o painel.
finish() { local code=$?; local st=ok; [ $code -ne 0 ] && st=falhou; python3 - "$LIVE" "$st" "$code" <<'PY' || true
import json, sys, datetime
p, st, code = sys.argv[1], sys.argv[2], int(sys.argv[3])
try: d = json.load(open(p))
except Exception: d = {}
d.update(state=st, code=code, ended=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))
d['updated'] = d['ended']
json.dump(d, open(p, 'w'))
PY
  # Ciclo que falhou só aparecia no painel, e num dia sem abrir o painel ninguém via. Código 3 é "nada a
  # publicar neste ciclo": é normal e não vira aviso.
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
    "$REPO/scripts/alerta.sh" ciclo-falhou "Bem Apoiado: o ciclo falhou (erro $code)" \
      "O ciclo que terminou às $(date +%H:%M) saiu com erro $code.

Últimas linhas do log:
$(tail -12 /var/lib/bem-apoiado/cycle-last.log 2>/dev/null)" || true
  fi
}
trap finish EXIT
export BEM_CYCLE_LIVE=1
cd "$REPO"
git merge --abort 2>/dev/null || true   # merge interrompido nunca fica pendurado
git fetch -q origin main
git checkout -q -f main
git reset -q --hard origin/main          # cópia da VPS é descartável: o main do GitHub manda
git clean -qfd -e node_modules -e .state
if ! cmp -s package-lock.json .state/last-lock 2>/dev/null; then
  npm ci --no-audit --no-fund >/dev/null
  mkdir -p .state && cp package-lock.json .state/last-lock
fi

# Pautas com PR do motor ainda não mesclado ficam de fora deste ciclo (ramo pagina/<slug>-AAAAMMDD-HHMM).
git fetch -q --prune origin '+refs/heads/pagina/*:refs/remotes/origin/pagina/*' || true
export BEM_PENDING_SLUGS=$(git branch -r --no-merged origin/main --list 'origin/pagina/*' \
  | sed -E 's#^ *origin/pagina/##; s#-[0-9]{8}-[0-9]{4}$##' | sort -u | paste -sd, -)
[ -n "$BEM_PENDING_SLUGS" ] && echo "aguardando merge: $BEM_PENDING_SLUGS"

# Avisa o dono do que ele não tem como adivinhar, com a linha "BLOQUEADO|serviço|veredito|detalhe|o que fazer"
# que o motor imprime. 28/10: o roteador recusou por falta de crédito e o ciclo virou "nada a publicar" — o
# alerta não dispara no código 3, e o silêncio durou horas.
avisa_bloqueio() {
  local linha=$1 quando=$2
  local servico detalhe resolver
  servico=$(cut -d'|' -f2 <<<"$linha"); detalhe=$(cut -d'|' -f4 <<<"$linha"); resolver=$(cut -d'|' -f5 <<<"$linha")
  "$REPO/scripts/alerta.sh" "provedor-$servico" "Bem Apoiado: o motor está parado ($servico)" \
    "$quando

$detalhe

O que fazer: $resolver

Enquanto isso, nenhuma página nova sai. O site no ar continua normal." || true
}

# Camada 1: conferir ANTES de gastar. Custa ~0,0003 crédito; o ciclo de 28/10 gastou 34,6 para descobrir o mesmo.
set +e
PRE=$(npm run -s engine -- preflight 2>&1)
PRECODE=$?
set -e
printf '%s\n' "$PRE"
if [ $PRECODE -eq 4 ]; then
  avisa_bloqueio "$(grep '^BLOQUEADO|' <<<"$PRE" | head -1)" "O ciclo das $(date +%H:%M) nem começou: o provedor recusou antes de qualquer gasto."
  echo "provedor bloqueado; ciclo não começou"
  exit 0
fi

set +e
OUT=$(npm run -s engine -- autopilot --budget "${BEM_CYCLE_BUDGET:-40}" 2>&1)
CODE=$?
set -e
echo "$OUT" | tail -5
printf '%s\n' "$OUT" | tail -40 > /var/lib/bem-apoiado/cycle-last.log
[ $CODE -ne 0 ] && [ $CODE -ne 3 ] && echo "$OUT" | tail -40   # erro: mostra o contexto inteiro no log
# Camada 2: "nada a publicar" é normal por falta de pauta, e NÃO é normal quando o provedor recusou no meio.
if [ $CODE -eq 3 ]; then
  set +e
  CLASS=$(npm run -s engine -- preflight-texto "$OUT" 2>&1)
  CLASSCODE=$?
  set -e
  [ $CLASSCODE -eq 4 ] && avisa_bloqueio "$(grep '^BLOQUEADO|' <<<"$CLASS" | head -1)" "O ciclo das $(date +%H:%M) rodou e não produziu nada."
fi
[ $CODE -eq 3 ] && { echo "nada a publicar neste ciclo"; exit 0; }
[ $CODE -ne 0 ] && { echo "autopilot falhou ($CODE)"; exit $CODE; }

SLUG=$(cat .pr/slug.txt)
BRANCH="pagina/${SLUG}-$(date +%Y%m%d-%H%M)"
git checkout -q -b "$BRANCH"
git add data/ site/src/assets/generated/
git diff --cached --quiet && { echo "sem mudanças em data/"; exit 0; }
git -c user.name="Bem Apoiado (motor)" -c user.email="motor@bemapoiado.invalid" \
  commit -q -F <(cat .pr/title.txt; echo; echo; cat .pr/body.md)
git push -q origin "$BRANCH"
echo "enviado: $BRANCH"
