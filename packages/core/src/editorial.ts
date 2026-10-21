// Padrão editorial do site (pedido do dono, 21/10): toda página é escrita e revisada contra estas perguntas.
// Fonte única: o redator recebe a lista no prompt e a revisão avalia cada uma.
export const EDITORIAL_STANDARD = [
  { id: 'decide', q: 'Isso ajuda quem está lendo a tomar uma decisão?' },
  { id: 'purchase', q: 'Isso leva à compra? (o leitor sai sabendo o que conferir no anúncio ou na ficha e qual opção serve para o caso dele; sem pressão nem promessa)' },
  { id: 'plain', q: 'Isso é fácil para leigos?' },
  { id: 'quick', q: 'Isso responde rapidamente a uma dúvida simples? (a resposta curta resolve sozinha, em até 3 frases)' },
] as const;

export const editorialChecklist = () => EDITORIAL_STANDARD.map((x) => `- ${x.q}`).join('\n');
