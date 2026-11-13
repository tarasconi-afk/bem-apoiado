# Aprendizados do ciclo de 13/11, 10:14–10:28 (Brasília)

Execução `20261113T131430_autopilot_fb74`: 61,9 créditos, rascunho reprovado de "pillow top ou topper".
Cada item: achado → causa (com evidência) → regra que fica → como verificar que não regrediu.

## 1. Comparação com um lado vazio foi à redação (≈ 40 créditos sem página)

- **Achado:** "pillow top ou topper" saiu NOT_PUBLISHABLE ("não apresenta um topper vendido como peça avulsa"). A correção automática foi aplicada e a nota de leitor ficou em 1,5 → 1,5 de 4.
- **Causa:** das 32 evidências da pauta (73 na pasta das fontes dela), **nenhuma** diz "topper". A checagem antes da redação aceitou 2 regras em que o pillow top de microfibra da Luuna fazia o papel de topper. Texto não cria o lado que falta: a correção não podia subir a nota.
- **O que já funcionou e fica:** "ajuste sem ganho vira aprendizado" (6351ccec, 23/10). Com nota igual, as faltas viraram lacunas da pauta ("um topper avulso usado como comparação…"). "Ajuste nunca piora a página" (24427f9c) e "a resposta curta continua mandando escolher" (e78ece3e) não foram mexidos.
- **Regra nova (`stages/lados.ts`, ligada em `readyOrResearch`):** uma pauta "A ou B" só vai ao redator se **cada lado** aparecer nas evidências da própria pauta. A palavra que distingue o lado é comparada pelo radical, então "viscoelástico" casa com "viscoelástica". Se faltar um lado, a pauta é adiada, a lacuna do lado é registrada e o ciclo não paga a redação. É a mesma ideia do motor FC (viabilidade, 29/10).
- **Como verificar:**
  - Teste `lados-da-decisao.test.ts`.
  - Aplicada às 30 comparações do repositório, a regra barra só "pillow top ou topper" e deixa passar as 21 páginas "A ou B" no ar e os rascunhos.
  - Nenhuma página no ar mudou.

## 2. Busca de produtos do lençol: 0 adicionado

- **Achado:** "produtos para como-escolher-lencol: 0 adicionado(s)".
- **Causa:** o relatório `products-amazon-como-escolher-lencol.json` tem **uma** consulta só ("solteiro solteirão casal Lençol"). Ela trouxe 10 anúncios: 9 com Marca "Genérico" e 1 de fabricante fora do cadastro. Essas 10 tentativas esgotaram a cota do tipo (`listingsPerKind` 10), e a busca por marca do cadastro (d9d5423b) não chegou a rodar.
- **Regra nova (`stages/products.ts`):** a busca por marca tem cota própria de 4 tentativas (`tentativasDaBuscaPorMarca`). A recusa de "Genérico" e as travas de fabricante não mudaram.
- **Como verificar:**
  - Teste em `assunto-resumo-marca.test.ts`.
  - No próximo "produtos para" de cama ou banho, o relatório deve listar as consultas "<tipo> <marca>".

## 3. Imagens (~10 créditos): sem desperdício

- **Achado:** capa de "tamanhos de toalha" e ilustração do produto B07J2VCPJ6.
- **Causa:** nenhuma falha.
  - A capa é de página no ar.
  - A Ortobom Sleep King entrou como modelo citado de "pillow top: o que é e vale a pena" e aparece nessa página.
  - Conferido com o próprio `productsFor` do site: os 32 produtos do catálogo aparecem em alguma página no ar.
- **Decisão:** a regra do FC ("ilustração só para produto em oferta publicável") **não** foi portada. No BA, o catálogo só recebe produto de página no ar, então ela não economizaria nada.

## 4. Revisão periódica da "toalha que enxuga melhor": 1 problema sem correção segura

- **Achado:** a linha "Appel Bambu Supreme" da tabela `composicao-fibras` cita um trecho que fala da mistura bambu e algodão egípcio sem nomear esse modelo.
- **O que o motor fez:** o conserto proposto trocaria a linha por dados da Karsten e foi descartado. A página publicada ficou como estava.
- **Repetição:** o problema não se repete a cada ciclo, porque `reaudit.json` registra a data.
- **Fica com o dono (painel):** pedir correção que tire essa linha, ou que a substitua por um modelo da Appel cuja ficha nomeie a composição. O motor não altera texto publicado sozinho.
