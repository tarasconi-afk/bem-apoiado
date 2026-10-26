# Recuperação e continuidade

Para quem (pessoa ou IA) precisa retomar o Bem Apoiado sem o histórico das conversas. O que está aqui vale
mais que lembrança: confira no código antes de agir.

## 1. Onde está cada coisa

| Peça | Onde | No git? |
|---|---|---|
| Código, dados (fontes, evidências, páginas, pautas, fila), docs | GitHub `tarasconi-afk/bem-apoiado`, ramo `main` | sim: é a fonte da verdade |
| Site publicado | Hostinger, conta `u226814741`, site `bemapoiado.com`, publica o ramo `deploy` | o ramo `deploy` é gerado pela Action `deploy.yml` |
| Motor (ciclos, painel, sync, contador) | VPS Hostinger `srv2079501` (IP 200.141.17.249, Ubuntu 24.04) | serviços em `infra/` (idênticos aos da VPS) |
| Estado da VPS | `/var/lib/bem-apoiado/` | não (ver seção 3) |
| Segredos | `/etc/bem-apoiado/env` e `/var/lib/bem-apoiado/gsc-key.json` na VPS; segredo `HOSTINGER_API_TOKEN` no GitHub | não, nunca |
| Search Console | propriedade `sc-domain:bemapoiado.com`, conta de serviço com acesso "Completo" | não |
| Afiliado | tag Amazon `bemapoiado-20` (`packages/core/src/schemas.ts`) | sim |
| IndexNow | chave pública em `site/public/<chave>.txt` e `packages/engine/src/announce.ts` | sim |

A VPS tem um clone completo do repositório (`/opt/bem-apoiado/repo`), com histórico. Ela e o GitHub são cópias
um do outro: perder um dos dois não perde o projeto.

## 2. Ordem de leitura para retomar

1. `AGENTS.md`: regras que não se negociam e padrão editorial.
2. Este arquivo.
3. `docs/ROADMAP.md`: fase atual, o que foi feito e o que falta, em ordem.
4. `docs/DECISIONS.md`: por que cada escolha foi feita. Antes de "simplificar" algo, procure aqui.
5. `docs/TESTES-2026-10-23.md`: como o motor foi medido e o que ainda trava "9 de 10 ciclos aprovados".
6. `data/dev-requests.json`: pedidos do dono feitos pelo painel que exigem código (status "aberto").
7. `infra/README.md`: serviços, horários, tetos, caminhos na VPS.

## 3. O que não está no git e como recriar

| Item | Para que serve | Se perder |
|---|---|---|
| `/etc/bem-apoiado/env`: `NEXOS_API_KEY`, `NEXOS_BASE_URL`, `TAVILY_API_KEY`, `TAVILY_MONTHLY_CAP`, `BRAVE_API_KEY` (reserva da busca, opcional) | IA (roteador) e busca | gerar chave nova nos painéis dos fornecedores; arquivo `root:bemapoiado 640` |
| `gsc-key.json` | leitura do Search Console e reenvio do sitemap | criar chave nova da conta de serviço no Google Cloud e colar no painel (Desempenho → Google Search Console) |
| `painel-auth.json` | senha do painel | `npm run -s engine -- admin-senha` (lê a senha da entrada padrão) |
| `/opt/bem-apoiado/.ssh/github_deploy` | a VPS envia commits ao GitHub | gerar par novo, cadastrar a chave pública em GitHub → Settings → Deploy keys com escrita |
| `credits-ledger.jsonl`, `llm-usage.json`, `tavily-usage.json` | gasto e tetos | recomeçam do zero; informar o saldo no painel |
| `hits/` | visitas e cliques na Amazon (contador próprio) | histórico perdido; único item não recriável. O Search Console guarda o do Google |
| demais (`deferred-topics`, `*-attempts`, `previas`, `gsc/`, `announce.json`) | controle de tentativas e prévias | o motor recria sozinho |

## 4. Cenários

**Perdi o computador ou o acesso à IA (VPS e GitHub intactos).** Nada se perde. O motor continua rodando
sozinho (4 ciclos por dia) e o painel (`https://admin.bemapoiado.com/`) continua funcionando.
- **Acesso à VPS:** terminal do navegador no hPanel, ou uma chave SSH nova cadastrada pelo hPanel.
- **Retomar com uma IA nova:** clonar o repositório e pedir que ela leia a seção 2 antes de mudar qualquer coisa.

**Perdi a VPS.**
1. VPS nova (Ubuntu 24.04), Node 22, Caddy, usuário `bemapoiado`.
2. `git clone` em `/opt/bem-apoiado/repo` com uma chave de deploy nova (seção 3) e `npm ci`.
3. Copiar `infra/*.service`, `*.timer` e `*.path` para `/etc/systemd/system/` e o `infra/Caddyfile` para
   `/etc/caddy/`. `systemctl daemon-reload` e ativar os timers.
4. Recriar `/etc/bem-apoiado/env`, a senha do painel e a chave do Search Console (seção 3).
5. Apontar o DNS do painel (`admin.bemapoiado.com`) e do contador (`t.bemapoiado.com`) para o IP novo.

O site não para: ele é servido pela hospedagem, não pela VPS.

**Perdi o GitHub.** O clone da VPS tem todo o histórico: criar um repositório novo, enviar `main` e `deploy`,
trocar o remoto na VPS e refazer a implantação por Git na Hostinger e o segredo `HOSTINGER_API_TOKEN`.

## 5. Como trabalhar neste projeto (combinado com o dono)

- **Papéis:** o dono é o editor e decide o que vai ao ar. Quem desenvolve é PM e dev, com autonomia técnica.
  Quando algo não dá certo e há o que aprender, escolha o mecanismo automático e explique depois.
- **Segurança do git:** nunca force push, nunca imprimir segredo (chaves, env, JSON da conta de serviço).
- **Antes de dizer "pronto":** `npm test`, `npm run typecheck` e `npm run build` passando, e conferir se o commit
  contém de fato as mudanças.
- **Publicação automática** (sem aceite no quadro) só com autorização explícita do dono.
- **Regras de qualidade:** não afrouxar para bater meta. Fonte primária, trecho literal, sem efeito de saúde,
  sem preço nem teste inventado.
- **Testar o motor sem tocar produção:** cópia em `/tmp` na VPS com `BEM_ROOT` e `BEM_STATE_DIR` próprios, pautas
  em sequência (ver `docs/TESTES-2026-10-23.md`).
- **Metas:** 20 páginas no ar para tração, 200 no fim; "9 de 10 ciclos aprovados" sem ajuste do editor.

## 6. Backup recomendado

- **Git:** já é backup duplo (GitHub e VPS).
- **VPS:** confirmar no hPanel que o backup semanal automático está ligado; um snapshot antes de mudança grande.
- **Segredos:** guardar `/etc/bem-apoiado/env` e o JSON da conta de serviço num gerenciador de senhas do dono.
  Nunca no git.
