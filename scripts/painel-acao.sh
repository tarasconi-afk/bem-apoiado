#!/usr/bin/env bash
# Ações do painel admin na VPS (usuário bemapoiado). Mesma regra do cycle.sh: o git é operado aqui,
# por código; o painel só escolhe a ação e passa argumentos já validados. Cada ação parte do main do
# GitHub, aplica a mudança, passa no gate e vai direto para o main (o clique no painel É a aprovação humana).
#
#   painel-acao.sh sync                         # alinha a cópia com o GitHub e refaz a prévia
#   painel-acao.sh veredito <slug> approve|reject <motivo>
#   painel-acao.sh fila-adicionar <consulta>
#   painel-acao.sh fila-remover <consulta>
#   painel-acao.sh ajustar <ramo|main> <slug> <pedido.txt>  # ajuste de texto antes de aceitar
#   painel-acao.sh pedido <arquivo.txt>         # pedido em texto livre (agente do painel)
#   painel-acao.sh editar <slug> <edits.json>   # edição manual de texto (só grava se o auditor sustentar)
#   painel-acao.sh produto-adicionar <link> <tipo> <marca> <nome> | produto-reconferir <ASIN> | produto-remover <ASIN>
#   painel-acao.sh dominio-aprovar <host> <classe> <publicador> | dominio-bloquear <host>
#   painel-acao.sh mesclar <ramo pagina/...> [ids]  # aceita o resultado; ids = itens desmarcados (não entram)
#   painel-acao.sh descartar <ramo pagina/...> # apaga o ramo; a pauta volta para a fila
set -euo pipefail
# Sempre a cópia de trabalho: o painel roda com BEM_ROOT apontando para a cópia só de leitura.
unset BEM_ROOT
REPO=/opt/bem-apoiado/repo
PREVIEW=/var/www/bem-apoiado
export GIT_SSH_COMMAND="ssh -i /opt/bem-apoiado/.ssh/github_deploy -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
GIT_ID=(-c user.name="Bem Apoiado (painel)" -c user.email="painel@bemapoiado.invalid")

# Cópia só de leitura do main que o painel lê (BEM_ROOT do bem-apoiado-admin): atualizada ao fim de toda ação
# e de todo sync, inclusive quando o sync sai porque o ciclo está rodando.
VIEW=/opt/bem-apoiado/view
update_view() {
  [ -e "$VIEW/.git" ] || git -C "$REPO" worktree add -q --detach "$VIEW" origin/main
  git -C "$VIEW" checkout -q -f --detach origin/main && git -C "$VIEW" clean -qfd
}
trap 'update_view >/dev/null 2>&1 || true' EXIT

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
    # Imagens geradas no ramo (capa nova): sem elas a prévia caía na ilustração antiga (21/10). Entram só
    # durante o build da prévia; depois a pasta volta exatamente ao main.
    git archive "$ref" site/src/assets/generated 2>/dev/null | tar -x -C . 2>/dev/null || true
    local ok=0
    BEM_ROOT="$tmp" SITE_URL=https://srv2079501.hstgr.cloud SITE_SHOW_DRAFTS=true SITE_BASE="/painel/previa/$dir/" \
        SITE_OUT_DIR="$PREVIAS/$dir.new" npm run -s build -w site >/dev/null 2>&1 && ok=1
    git checkout -q -- site/src/assets/generated; git clean -qfd site/src/assets/generated
    if [ $ok = 1 ]; then
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
  local live; live=$(curl -fsS -m 20 "https://bemapoiado.com/?v=$(date +%s)" 2>/dev/null | grep -o 'name="bem-build" content="[0-9a-f]*"' | grep -o '[0-9a-f]\{40\}' || true)
  printf '{"checked_at":"%s","live":"%s","main":"%s","main_at":"%s"}\n' "$(date -u +%FT%TZ)" "$live" "$(git rev-parse HEAD)" "$(git log -1 --format=%cI)" > /var/lib/bem-apoiado/live-site.json
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

# Mescla um resultado do motor no main. excl = ids (painel) dos itens que o editor desmarcou: depois do
# merge, só esses arquivos voltam à versão do main (produto recusado vai para products-retired/).
merge_branch() {
  local ramo=$1 excl=${2:-}
  fresh
  # Conflito em data/ (o main mexeu na mesma pauta enquanto o ramo esperava): vale o ramo, que é o
  # resultado mais novo do motor. Código nunca vem de ramo pagina/*, então só data/ pode conflitar.
  if ! git "${GIT_ID[@]}" merge -q --no-ff -X theirs -m "Painel: mescla $ramo" "origin/$ramo"; then
    git merge --abort 2>/dev/null || true
    echo "conflito que não dá para resolver sozinho em $ramo; nada foi enviado" >&2; return 4
  fi
  if grep -rlq '^<<<<<<< ' data; then git reset -q --hard origin/main; echo "marcador de conflito em data/; nada foi enviado" >&2; return 4; fi
  if [ -n "$excl" ]; then
    local out; out=$(npm run -s engine -- changes-exclude "origin/$ramo" "$excl") || { git reset -q --hard origin/main; echo "não deu para separar os itens; nada foi enviado" >&2; return 3; }
    echo "$out"
    git add -A data site/src/assets/generated
    git diff --cached --quiet || git "${GIT_ID[@]}" commit -q -m "Painel: itens recusados de $ramo"$'\n\n'"$out"
  fi
  # O gate completo do PR (testes + typecheck + build) antes de ir ao main. Cada um checado: com
  # "a && b && c" o set -e não para quando um deles falha (foi assim que um teste vermelho passou).
  npm test >/tmp/painel-test.log 2>&1 || { tail -30 /tmp/painel-test.log; git reset -q --hard origin/main; echo "testes falharam; nada foi enviado" >&2; return 3; }
  npm run -s typecheck || { git reset -q --hard origin/main; echo "typecheck falhou; nada foi enviado" >&2; return 3; }
  npm run -s build >/dev/null || { git reset -q --hard origin/main; echo "build/validate falhou; nada foi enviado" >&2; return 3; }
  # O main andou durante a mesclagem (22/10: uma mudança de fila chegou no meio e o editor viu "envio falhou"):
  # refaz sobre o main novo, valida e envia de novo, como o publish; só desiste se isso também falhar.
  if ! git push -q origin HEAD:main; then
    if ! { git fetch -q origin main && git rebase -q origin/main && npm run -s engine -- validate >/dev/null && git push -q origin HEAD:main; }; then
      git rebase --abort 2>/dev/null || true; git reset -q --hard origin/main; echo "envio ao GitHub falhou mesmo depois de atualizar; nada foi enviado, tente de novo" >&2; return 5
    fi
  fi
  git push -q origin --delete "$ramo" || true
  echo "mesclado: $ramo"
}

# Resultado que só traz aprendizado (nada que o leitor veja) entra sozinho, pelo mesmo gate. Falhou o
# gate: fica esperando decisão e não tenta de novo para o mesmo commit.
auto_learning() {
  for ref in $(git for-each-ref --no-merged=origin/main --format='%(refname:short)' refs/remotes/origin/pagina/); do
    local b=${ref#origin/} sha; sha=$(git rev-parse "$ref")
    grep -qx "$sha" .state/auto-failed 2>/dev/null && continue
    [ "$(npm run -s engine -- changes "$ref" --publicas 2>/dev/null)" = 0 ] || continue
    if merge_branch "$b" >/dev/null 2>&1; then echo "aprendizado guardado sozinho: $b"; else mkdir -p .state; echo "$sha" >> .state/auto-failed; echo "aprendizado de $b não passou no gate; fica para decisão" >&2; fi
    fresh
  done
}

action=${1:-}
case "$action" in
  sync)
    fresh
    auto_learning
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
  ajustar)
    # ajustar <ramo pagina/...|main> <slug> <pedido.txt>: ajusta o texto da página no próprio resultado do
    # motor (antes do aceite) ou, se for página no ar, num resultado novo; nos dois casos o editor aprova.
    fresh
    B="$2"
    # Ajuste em página no ar volta para aprovação com prévia (22/10: o editor pediu melhoria e ela foi
    # direto ao site). Se a página já tem um resultado pendente, o ajuste entra nele. Rascunho fica no main:
    # já é aprovado em "Páginas: seu veredito", e num ramo virava resultado "nada muda no site".
    if [ "$B" = main ] && ! git show "origin/main:data/pages/$3.json" | grep -q '"status": "draft"'; then
      B=$(git for-each-ref --no-merged=origin/main --sort=-committerdate --format='%(refname:short)' "refs/remotes/origin/pagina/$3-[0-9]*" | head -1)
      B=${B#origin/}
      [ -n "$B" ] || B="pagina/$3-$(date +%Y%m%d-%H%M)"
    fi
    if [ "$B" = main ]; then
      git checkout -q -B main origin/main
    elif git rev-parse -q --verify "origin/$B" >/dev/null; then
      git checkout -q -B "$B" "origin/$B"
      # Dados do ramo, código do main: o ramo tem o motor da hora em que foi criado, e o ajuste rodava com
      # ele (21/10: a correção do ajuste já estava no main e não valeu). Só na cópia de trabalho; o commit
      # abaixo leva só data/. scripts/ fica de fora (este script está rodando).
      git restore --source=origin/main --worktree -- packages site package.json package-lock.json
    else
      git checkout -q -B "$B" origin/main
    fi
    if ! npm run -s engine -- adjust "$3" "$4" ${5:+--pesquisar}; then
      git checkout -q -f main; git reset -q --hard origin/main; echo "ajuste NÃO salvo (veja o motivo acima)" >&2; exit 1
    fi
    git add data/
    git "${GIT_ID[@]}" commit -q -m "Painel: ajuste em $3${5:+ (com pesquisa)}"$'\n\n'"$(head -c 300 "$4")"
    npm run -s engine -- validate >/dev/null
    if [ "$B" = main ]; then
      # O main andou durante o ajuste (21/10: push do editor no meio, envio recusado e ajuste perdido): refaz
      # sobre o main novo e envia de novo, como o publish.
      if ! git push -q origin HEAD:main; then
        git fetch -q origin main && git rebase -q origin/main && npm run -s engine -- validate >/dev/null && git push -q origin HEAD:main
      fi
      preview
      echo "rascunho ajustado: $3; confira a prévia e decida em \"Páginas: seu veredito\""
    else
      git push -q origin "HEAD:$B"
      git checkout -q -f main
      branch_previews 2>/dev/null || true   # a prévia do resultado aparece já (antes esperava o próximo sync)
      echo "ajuste salvo para aprovação ($B): $3; confira a prévia em Decisões"
    fi
    git checkout -q -f main
    ;;
  pedido)
    fresh
    npm run -s engine -- request "$2"
    if [ -z "$(git status --porcelain -- data/theme.json)" ]; then
      publish "Painel: pedido do editor"$'\n\n'"$(head -c 300 "$2")"
      preview
    else
      # Mudança de tema vai para um resultado com prévia (ramo pagina/tema-*); só vale com o aceite.
      B="pagina/tema-$(date +%Y%m%d-%H%M)"
      git checkout -q -b "$B"
      git add data/
      git "${GIT_ID[@]}" commit -q -m "Tema: pedido do editor"$'\n\n'"- $(head -c 300 "$2")"
      git push -q origin "HEAD:$B"
      git checkout -q -f main
      echo "mudança de tema em $B: confira a prévia em Esperando sua decisão"
    fi
    ;;
  editar)
    fresh
    if ! npm run -s engine -- manual-edit "$2" "$3"; then
      git reset -q --hard origin/main; echo "edição NÃO salva: o auditor não sustentou os blocos acima" >&2; exit 1
    fi
    publish "Painel: edição manual em $2"
    preview
    ;;
  produto-adicionar)
    # produto-adicionar <link> <tipo> <marca> <nome>: escolha do editor (o clique é a aprovação humana).
    fresh
    npm run -s engine -- product-pick "$2" "$3" "$4" "$5"
    publish "Painel: produto escolhido pelo editor ($5)"
    preview
    ;;
  produto-reconferir)
    fresh
    npm run -s engine -- product-recheck "$2"
    publish "Painel: produto reconferido pelo editor ($2)"
    ;;
  produto-remover)
    fresh
    npm run -s engine -- product-remove "$2" "removido pelo editor no painel"
    publish "Painel: produto removido pelo editor ($2)"
    preview
    ;;
  licao-remover)
    fresh
    npm run -s engine -- lesson-remove "$2"
    publish "Painel: lição do editor removida ($2)"
    ;;
  dominio-aprovar)
    fresh
    npm run -s engine -- registry allow "$2" "$3" "$4"
    publish "Painel: domínio aprovado $2 ($3, $4)"
    ;;
  dominio-bloquear)
    fresh
    npm run -s engine -- registry block "$2"
    publish "Painel: domínio bloqueado $2"
    ;;
  mesclar)
    merge_branch "$2" "${3:-}"
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
