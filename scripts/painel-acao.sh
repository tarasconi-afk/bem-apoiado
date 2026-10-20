#!/usr/bin/env bash
# Ações do painel admin na VPS (usuário bemapoiado). Mesma regra do cycle.sh: o git é operado aqui,
# por código; o painel só escolhe a ação e passa argumentos já validados. Cada ação parte do main do
# GitHub, aplica a mudança, passa no gate e vai direto para o main (o clique no painel É a aprovação humana).
#
#   painel-acao.sh sync                         # alinha a cópia com o GitHub e refaz a prévia
#   painel-acao.sh veredito <slug> approve|reject <motivo>
#   painel-acao.sh fila-adicionar <consulta>
#   painel-acao.sh fila-remover <consulta>
#   painel-acao.sh mesclar <ramo pagina/...>   # aceita o resultado de um ciclo do motor
#   painel-acao.sh descartar <ramo pagina/...> # apaga o ramo; a pauta volta para a fila
set -euo pipefail
REPO=/opt/bem-apoiado/repo
PREVIEW=/var/www/bem-apoiado
export GIT_SSH_COMMAND="ssh -i /opt/bem-apoiado/.ssh/github_deploy -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
GIT_ID=(-c user.name="Bem Apoiado (painel)" -c user.email="painel@bemapoiado.invalid")

# Mesmo lock do ciclo: ação do painel nunca roda no meio de um ciclo (nem o contrário).
exec 9>/var/lib/bem-apoiado/cycle.lock
if [ "${1:-}" = sync ]; then flock -n 9 || exit 0; else flock -w 120 9 || { echo "motor ocupado; tente de novo em alguns minutos"; exit 75; }; fi

cd "$REPO"
fresh() {
  git fetch -q --prune origin main '+refs/heads/pagina/*:refs/remotes/origin/pagina/*'
  git checkout -q main
  git reset -q --hard origin/main
  git clean -qfd -e node_modules -e .state
  if ! cmp -s package-lock.json .state/last-lock 2>/dev/null; then
    npm ci --no-audit --no-fund >/dev/null
    mkdir -p .state && cp package-lock.json .state/last-lock
  fi
}

# Prévia da VPS: inclui rascunhos (é o lugar de lê-los antes do veredito). Só refaz quando o main muda.
preview() {
  local head; head=$(git rev-parse HEAD)
  [ "$(cat .state/preview-head 2>/dev/null)" = "$head" ] && return 0
  SITE_URL=https://srv2079501.hstgr.cloud SITE_SHOW_DRAFTS=true npm run -s build >/dev/null
  rsync -a --delete site/dist/ "$PREVIEW/"
  echo "$head" > .state/preview-head
}

# Commit no main + push. Se o main andou no meio (merge no GitHub), refaz sobre o novo main uma vez.
publish() {
  local msg=$1
  git add data/
  git diff --cached --quiet && { echo "nada mudou"; return 0; }
  npm run -s engine -- validate >/dev/null
  git "${GIT_ID[@]}" commit -q -m "$msg"
  if ! git push -q origin HEAD:main; then
    git fetch -q origin main && git rebase -q origin/main && npm run -s engine -- validate >/dev/null && git push -q origin HEAD:main
  fi
  echo "enviado ao main: $msg"
}

action=${1:-}
case "$action" in
  sync)
    fresh
    preview
    ;;
  veredito)
    fresh
    npm run -s engine -- verdict "$2" "$3" --reason "$4"
    publish "Painel: veredito $3 em $2"$'\n\n'"Motivo: $4"
    preview
    ;;
  fila-adicionar|fila-remover)
    fresh
    op=add; [ "$action" = fila-remover ] && op=remove
    npm run -s engine -- queue "$op" "$2"
    publish "Painel: fila ${action#fila-} \"$2\""
    ;;
  mesclar)
    fresh
    git "${GIT_ID[@]}" merge -q --no-ff -m "Painel: mescla $2" "origin/$2"
    # O gate completo do PR (testes + build), rodado aqui antes de ir ao main.
    npm test >/dev/null && npm run -s typecheck && npm run -s build >/dev/null
    git push -q origin HEAD:main
    git push -q origin --delete "$2" || true
    echo "mesclado: $2"
    preview
    ;;
  descartar)
    fresh
    git push -q origin --delete "$2"
    echo "descartado: $2"
    ;;
  *)
    echo "ação desconhecida: $action" >&2
    exit 2
    ;;
esac
