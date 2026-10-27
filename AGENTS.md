# Bem Apoiado

Site de afiliados (Amazon BR) sobre decisões de compra em sono e home office: colchão, travesseiro,
base de cama, cadeira, mesa. O produto real é o **motor**: pesquisa, evidência, redação, auditoria e
publicação com o mínimo de intervenção humana.

## Regras que não se negociam

- Toda afirmação factual aponta para um `claim` com trecho **literal** de um snapshot em `data/sources/`.
  `npm run validate` confere isso de forma determinística; build não passa com violação.
- Nunca inventar preço, teste, medição, avaliação ou experiência prática. Não testamos produtos.
- Especificação vem de fabricante, norma ou regulador. Anúncio de loja só prova disponibilidade.
- Saúde: nunca afirmar efeito terapêutico (dor, coluna, ronco). Falar de especificação e ajuste;
  indicar profissional quando o assunto for dor.
- LLM é função JSON-in/JSON-out com saída validada por código. LLM nunca executa shell, git ou deploy.
- O LLM referencia evidências por `claim_id` de lista fechada, nunca por índice.
- Indexação só com `SITE_INDEXABLE=true` explícito, e só no domínio definitivo.
- Nada de estado em `/tmp`: fontes, evidências, páginas e runs vivem em `data/` e vão para o git.

## Padrão editorial (régua de toda página e de toda mudança no motor)
1. Isso ajuda quem está lendo a tomar uma decisão?
2. Isso leva à compra? (o leitor sabe o que conferir no anúncio/ficha e que opção serve para ele; sem pressão)
3. Isso é fácil para leigos?
4. Isso responde rapidamente a uma dúvida simples? (a resposta curta resolve sozinha)
Fonte única no código: `packages/core/src/editorial.ts` (redator e revisão usam a mesma lista).

## Comandos

- `npm run check` antes de qualquer push: teste, typecheck, validate e build, nessa ordem.
  27/10: um push com `npm test` e `npm run build` verdes quebrou o typecheck, e com ele TODO botão
  "Aplicar" do painel (o script roda typecheck antes de enviar) e o build do site no GitHub. Por isso
  `build` passou a rodar `typecheck` antes.
- Avulsos: `npm test` · `npm run typecheck` · `npm run validate` · `npm run build`
- `npm run engine -- snapshot <url> --publisher "X" --class manufacturer|regulator|standard_body|independent_test|retailer_listing|other`

## Onde ler antes de mudar algo

- `docs/RECUPERACAO.md`: onde está cada coisa, o que fica fora do git e como retomar o projeto do zero.
- `docs/RECUPERACAO.md`: onde está cada coisa, o que fica fora do git e como retomar o projeto do zero.
- `docs/ARCHITECTURE.md`: peças e fluxo.
- `docs/DECISIONS.md`: por que cada escolha foi feita (inclui lições do projeto anterior).
- `docs/ROADMAP.md`: fase atual e próximo passo.


## Pedidos do dono pelo painel
No início de cada sessão de desenvolvimento, ler `data/dev-requests.json` (itens com status "aberto"): são pedidos feitos no agente do painel que exigem mudança de código, visual ou regra. Ao atender, marcar `status: "feito"` com uma nota.
