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
  # Merge interrompido (ex.: conflito) nunca fica pendurado: a cópia volta ao main do GitHub.
  git merge --abort 2>/dev/null || true
  git fetch -q --prune origin main '+refs/heads/pagina/*:refs/remotes/origin/pagina/*'
  git checkout -q -f main
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

# Prévia de cada ramo do motor ainda não aceito: o build usa os dados do ramo (git archive de data/)
# com o código do main, em /painel/previa/<ramo>/ (atrás da senha do painel). Só refaz quando o ramo anda.
PREVIAS=/var/lib/bem-apoiado/previas
branch_previews() {
  mkdir -p "$PREVIAS"
  local keep=" "
  for ref in $(git for-each-ref --no-merged=origin/main --format='%(refname:short)' refs/remotes/origin/pagina/); do
    local b=${ref#origin/} dir=${ref#origin/pagina/} sha; sha=$(git rev-parse "$ref")
    keep="$keep$dir "
    [ "$(cat "$PREVIAS/$dir/.sha" 2>/dev/null)" = "$sha" ] && continue
    local tmp; tmp=$(mktemp -d)
    git archive "$ref" data | tar -x -C "$tmp"
    # Ramo criado antes de uma imagem existir: completa com o registro do main (sem sobrescrever o do ramo).
    [ -f "$tmp/data/images/registry.json" ] || { mkdir -p "$tmp/data/images" && cp data/images/*.json "$tmp/data/images/"; }
    if BEM_ROOT="$tmp" SITE_URL=https://srv2079501.hstgr.cloud SITE_SHOW_DRAFTS=true SITE_BASE="/painel/previa/$dir/" \
        SITE_OUT_DIR="$PREVIAS/$dir.new" npm run -s build -w site >/dev/null 2>&1; then
      rm -rf "$PREVIAS/$dir" && mv "$PREVIAS/$dir.new" "$PREVIAS/$dir" && echo "$sha" > "$PREVIAS/$dir/.sha"
      echo "prévia: $b"
    else
      rm -rf "$PREVIAS/$dir.new"; echo "prévia falhou: $b" >&2
    fi
    rm -rf "$tmp"
  done
  # Ramo aceito ou descartado: a prévia sai.
  for d in "$PREVIAS"/*/; do
    [ -d "$d" ] || continue; local n; n=$(basename "$d")
    case "$keep" in *" $n "*) ;; *) rm -rf "$d" ;; esac
  done
}

# O site público está na versão do main? (a implantação por Git da Hostinger às vezes não dispara)
live_check() {
  local live; live=$(curl -fsS -m 20 "https://darkslategrey-rail-669974.hostingersite.com/?v=$(date +%s)" 2>/dev/null | grep -o 'name="bem-build" content="[0-9a-f]*"' | grep -o '[0-9a-f]\{40\}' || true)
  printf '{"checked_at":"%s","live":"%s","main":"%s"}\n' "$(date -u +%FT%TZ)" "$live" "$(git rev-parse HEAD)" > /var/lib/bem-apoiado/live-site.json
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
    branch_previews
    live_check
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
    # Conflito em data/ (o main mexeu na mesma pauta enquanto o ramo esperava): vale o ramo, que é o
    # resultado mais novo do motor. Código nunca vem de ramo pagina/*, então só data/ pode conflitar.
    if ! git "${GIT_ID[@]}" merge -q --no-ff -X theirs -m "Painel: mescla $2" "origin/$2"; then
      git merge --abort 2>/dev/null || true
      echo "conflito que não dá para resolver sozinho em $2; nada foi enviado" >&2; exit 4
    fi
    if grep -rlq '^<<<<<<< ' data; then git reset -q --hard origin/main; echo "marcador de conflito em data/; nada foi enviado" >&2; exit 4; fi
    # O gate completo do PR (testes + typecheck + build) antes de ir ao main. Cada um checado: com
    # "a && b && c" o set -e não para quando um deles falha (foi assim que um teste vermelho passou).
    npm test >/tmp/painel-test.log 2>&1 || { tail -30 /tmp/painel-test.log; git reset -q --hard origin/main; echo "testes falharam; nada foi enviado" >&2; exit 3; }
    npm run -s typecheck || { git reset -q --hard origin/main; echo "typecheck falhou; nada foi enviado" >&2; exit 3; }
    npm run -s build >/dev/null || { git reset -q --hard origin/main; echo "build/validate falhou; nada foi enviado" >&2; exit 3; }
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
