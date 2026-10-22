# Auditoria de 21/10/2026 (site, páginas, motor, painel)

## Páginas no ar (6)
| Página | Resposta curta | Observações |
|---|---|---|
| base para cama box | ok depois do ajuste; ainda genérica | sem capa (ciclo das 17h52 caiu antes do envio), sem buscas e âncoras: próximo ciclo gera |
| colchão D28 ou D33 | abre com "Segundo a Ortobom" | "trechos citados" em 2 blocos |
| colchão de molas ou espuma | 5 frases | "trechos citados" em 1 bloco; 3 exemplos à venda |
| como escolher cadeira | abre com teleatendimento/Anexo II | 2 escolhas do editor (MAAT, Python Fly) |
| como escolher colchão | descreve catálogo ("Segundo a Ortobom, há modelos...") | enchimento 57% na revisão; aprovada pelo editor |
| como escolher travesseiro | vaga ("A escolha pode considerar...") | sem produto à venda (só buscas) |

Nenhuma página tem título de seção em forma de pergunta; 2 de 6 têm tabela. A manutenção nova reescreve o
resumo de 1 página por ciclo quando a resposta curta não passa na trava ou a revisão a marcou como fraca;
sai como resultado para o editor aceitar.

## Site (HTML gerado)
Sem link interno quebrado, sem imagem sem texto alternativo, JSON-LD válido, canonical e H1 únicos em todas as
páginas. Único aviso: título de "como escolher colchão" com 67 caracteres (limite 70; corta no Google ~60).

## Pesquisa de concorrentes (Sleep Foundation, Consumer Reports, RTINGS, mybest, Buscapé, CNN Brasil Review)
Adotado: resposta direta no topo (já havia), resumo antes dos detalhes, caixa "Como este guia foi feito" com os
nossos limites, links internos entre guias irmãos (já havia), botões com o destino no rótulo (já havia), e no
redator: títulos em pergunta, tabela de decisão por perfil, "para quem é / não é", checklist antes de comprar.
Não adotado: ranking, preço, notas, "testamos X produtos", FAQ como tática de schema (o Google tirou o rich result
de FAQ em 15/06/2026; recursos de IA não pedem schema especial). Aviso de afiliado no topo: o editor pediu para
esconder a linha de comissão (fica no rodapé).

## Motor (feito hoje)
Trava da resposta curta (até 3 frases; não abre com norma, anexo, regulador nem "Segundo a <marca>"; sem
"trechos citados"); redator recebe no máximo 60 evidências (as ligadas às perguntas, uma por fonte primeiro);
conexão cortada com o roteador tenta de novo; escalada para o Sonnet só se a 1ª tentativa custou até 15 créditos;
fabricantes ainda não lidos primeiro e busca aberta com menos de 2 fabricantes na pauta; lições do editor no
redator, no planejador e na busca.

## Painel (feito hoje)
Fila de ações; produto escolhido pelo editor; itens por resultado; recarga só quando algo muda (mesma aba e
rolagem); lê cópia só de leitura do main (não oscila); lições removíveis; cliques por cartão e por busca.

## Pendente (por prioridade)
1. Instalar na VPS o painel lendo a cópia só de leitura (depois do push: unidade do admin com BEM_ROOT=view).
2. Medir as próximas 5 páginas: taxa de aprovação, custo e se a resposta curta passa de primeira.
3. Edição de tabelas no painel.
4. Registro de mudanças por página ("Atualizações"), como Sleep Foundation e RTINGS.
5. Renovação mensal das fontes; Search Console quando houver dados; calibração com 8 vereditos.
6. Hub por perfil na home ("dorme de lado", "home office pequeno"), sem temas de saúde vetados.

## Adendo de 21/10 à noite (auto-auditoria: admin, leitor, Google, monetização)
- Motor: a página "colchão firme ou macio" (aprovada pelo editor como modelo) entra no pedido ao redator como
  exemplo de forma: resposta curta que começa pela ação do leitor com o dado que decide, e tabela no "Como decidir".
- Repetição: detectada no código (sobreposição ≥ 80% das palavras, mínimo 8); quando cruza decisão e detalhe, sai
  a cópia do detalhe (a decisão fica no topo). Removidas 8 repetições em 6 páginas no ar; vira regra de forma para
  páginas novas e manutenção por ciclo.
- Reescrita do resumo mantém as tabelas que já existiam (a D28 perdeu a tabela D28 × D33 num teste; corrigido).
- Resumos reescritos e revisados um a um: D28 ou D33 e base box aplicados; "como escolher colchão", travesseiro e
  cadeira mantidos (o resultado não era melhor: o problema dessas três é de pesquisa, não de texto).
- Leitor no celular: tipos em faixa compacta (a resposta curta aparece na primeira tela), tabela de 2–3 colunas sem
  rolagem lateral, texto dos exemplos à venda conforme o tipo de cartão.
- Admin: aba Decisões abre pelo que pede decisão (pedido ao motor por último), cartão de créditos de hoje contra o
  teto do dia, páginas no ar e em rascunho no mesmo cartão, links legíveis no modo escuro.
- Google: sem pendência técnica (sem link quebrado, imagem sem alt ou JSON-LD inválido; dateModified presente).
- Monetização: buscas na Amazon em todas as páginas no ar; cartões dos colchões renovados pelo índice de busca;
  cadeira com 2 escolhas do editor.
- Ainda pendente: "como escolher colchão" e "como escolher travesseiro" precisam de pesquisa nova (pouca evidência
  útil); cadeira de escritório ainda abre pelo teleatendimento; títulos de seção em pergunta só nas páginas novas.
