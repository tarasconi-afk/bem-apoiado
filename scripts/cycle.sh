#!/usr/bin/env bash
# Um ciclo do piloto automático na VPS (usuário bemapoiado). O git é operado AQUI, por código;
# o LLM nunca executa git. Resultado vai para um ramo pagina/* e o Action abre o PR.
set -euo pipefail
REPO=/opt/bem-apoiado/repo
export GIT_SSH_COMMAND="ssh -i /opt/bem-apoiado/.ssh/github_deploy -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
exec 9>/var/lib/bem-apoiado/cycle.lock
flock -n 9 || { echo "outro ciclo em andamento; saindo"; exit 0; }

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

set +e
OUT=$(npm run -s engine -- autopilot --budget "${BEM_CYCLE_BUDGET:-40}" 2>&1)
CODE=$?
set -e
echo "$OUT" | tail -5
printf '%s\n' "$OUT" | tail -40 > /var/lib/bem-apoiado/cycle-last.log
[ $CODE -ne 0 ] && [ $CODE -ne 3 ] && echo "$OUT" | tail -40   # erro: mostra o contexto inteiro no log
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
